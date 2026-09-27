import type {
  PublicationClaim,
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";
import { PublicationOutcomeUnknownError } from "./publication.port.js";

const PUBLICATION_HEARTBEAT_INTERVAL_MS = 60_000;
class PublicationLeaseLostError extends Error {}

export class ProcessPublicationIntent {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(intentId: string): Promise<boolean> {
    const claim = await this.repository.claim(intentId, this.clock());
    if (!claim) return false;
    const abortController = new AbortController();
    const heartbeat = this.startHeartbeat(claim, abortController);
    try {
      return await this.processClaim(claim, abortController.signal);
    } finally {
      clearInterval(heartbeat);
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
      await this.repository.failFinal(
        claim,
        "PUBLICATION_PROVIDER_UNAVAILABLE",
        "No enabled adapter exists for the requested platform.",
        this.clock(),
      );
      return true;
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
      if (error instanceof PublicationLeaseLostError) return false;
      if (externalWriteConfirmed) throw error;
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
        .catch(() => undefined)
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
