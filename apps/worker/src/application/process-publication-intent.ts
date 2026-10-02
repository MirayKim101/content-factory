import type {
  PublicationClaim,
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";
import {
  PublicationOutcomeUnknownError,
  PublicationPermanentError,
} from "./publication.port.js";
import { createAbortDeadline } from "./abort-deadline.js";

const PUBLICATION_HEARTBEAT_INTERVAL_MS = 60_000;
const PUBLICATION_ATTEMPT_TIMEOUT_MS = 30 * 60_000;
class PublicationLeaseLostError extends Error {}
class PublicationShutdownError extends Error {}

export class ProcessPublicationIntent {
  private readonly activeControllers = new Set<AbortController>();
  private readonly admittedPlatforms: PublicationClaim["platform"][];
  private stopping = false;

  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
    private readonly attemptTimeoutMs = PUBLICATION_ATTEMPT_TIMEOUT_MS,
  ) {
    this.admittedPlatforms = [
      ...new Set(providers.map((provider) => provider.platform)),
    ];
  }

  abortAll(): void {
    this.stopping = true;
    for (const controller of this.activeControllers)
      controller.abort(new PublicationShutdownError());
  }

  async execute(intentId: string): Promise<boolean> {
    if (this.stopping) return false;
    const claim = await this.repository.claim(
      intentId,
      this.clock(),
      this.admittedPlatforms,
    );
    if (!claim) return false;
    if (this.stopping) {
      await this.repository
        .releaseClaim(claim, this.clock())
        .catch(() => false);
      return false;
    }
    const abortController = new AbortController();
    this.activeControllers.add(abortController);
    const heartbeat = this.startHeartbeat(claim, abortController);
    const deadline = createAbortDeadline(
      abortController.signal,
      this.attemptTimeoutMs,
      "PUBLICATION_ATTEMPT_TIMEOUT",
    );
    try {
      return await this.processClaim(claim, deadline.signal);
    } finally {
      deadline.dispose();
      clearInterval(heartbeat);
      this.activeControllers.delete(abortController);
    }
  }

  private async processClaim(
    claim: PublicationClaim,
    signal: AbortSignal,
  ): Promise<boolean> {
    const provider = this.providers.find(
      (candidate) => candidate.platform === claim.platform,
    );
    if (!provider) {
      // A provider-specific rollout flag may be disabled temporarily. Preserve
      // the durable intent and any resumable session so re-enabling the exact
      // adapter can continue safely instead of turning rollback into data loss.
      await this.repository.releaseClaim(claim, this.clock());
      return false;
    }
    let externalWriteConfirmed = false;
    try {
      const result = await provider.publish(claim, signal);
      externalWriteConfirmed = claim.platform !== "LOCAL_DRY_RUN";
      if (claim.platform === "LOCAL_DRY_RUN")
        await this.repository.finalizeDryRun(claim, result, this.clock());
      else {
        try {
          await this.repository.finalizePublishedDirect(
            claim,
            result,
            this.clock(),
          );
        } catch {
          await this.repository.markUnknownRemoteState(
            claim,
            "PUBLICATION_FINALIZE_OUTCOME_UNKNOWN",
            "Provider confirmed publication, but local finalization failed.",
            providerResultId(result.providerReceipt),
            "provider_confirmed",
            this.clock(),
          );
        }
      }
      return true;
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) {
        await this.repository.markUnknownRemoteState(
          claim,
          error.code,
          error.message,
          error.remotePublicationId,
          error.remoteStatus,
          this.clock(),
        );
        return true;
      }
      if (error instanceof PublicationPermanentError) {
        await this.repository.failFinal(
          claim,
          error.code,
          error.message,
          this.clock(),
        );
        return true;
      }
      if (signal.reason instanceof PublicationLeaseLostError) return false;
      if (externalWriteConfirmed) throw error;
      if (signal.reason instanceof PublicationShutdownError) {
        await this.repository.releaseClaim(claim, this.clock());
        return false;
      }
      if (
        claim.platform !== "LOCAL_DRY_RUN" &&
        signal.reason instanceof Error &&
        signal.reason.message === "PUBLICATION_ATTEMPT_TIMEOUT"
      ) {
        await this.repository.markUnknownRemoteState(
          claim,
          "PUBLICATION_ATTEMPT_TIMEOUT",
          "Provider attempt timed out; remote outcome requires reconciliation.",
          null,
          "attempt_timeout",
          this.clock(),
        );
        return true;
      }
      if (claim.platform !== "LOCAL_DRY_RUN") {
        await this.repository.releaseForRetry(
          claim,
          "PUBLICATION_PROVIDER_ATTEMPT_FAILED",
          error instanceof Error ? error.message : "Provider attempt failed.",
          this.clock(),
        );
        return true;
      }
      await this.repository.failFinal(
        claim,
        "PUBLICATION_DRY_RUN_FAILED",
        error instanceof Error ? error.message : "Dry-run adapter failed.",
        this.clock(),
      );
      throw error;
    }
  }

  private startHeartbeat(
    claim: PublicationClaim,
    abortController: AbortController,
  ): ReturnType<typeof setInterval> {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.repository
        .heartbeat(claim, this.clock())
        .then((retained) => {
          if (!retained && !abortController.signal.aborted)
            abortController.abort(new PublicationLeaseLostError());
        })
        .catch(() => {
          // A failed heartbeat cannot prove lease ownership. Continuing an
          // external POST would allow a recovered worker to publish the same
          // intent concurrently after the stale-processing window elapses.
          if (!abortController.signal.aborted)
            abortController.abort(new PublicationLeaseLostError());
        })
        .finally(() => {
          running = false;
        });
    }, PUBLICATION_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

function providerResultId(receipt: Record<string, unknown>): string | null {
  const value = receipt.videoId ?? receipt.publishId ?? receipt.id;
  return typeof value === "string" && value && value.length <= 255
    ? value
    : null;
}
