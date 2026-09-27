import type {
  PublicationReconciliationClaim,
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";
import { createAbortDeadline } from "./abort-deadline.js";

const RECONCILIATION_HEARTBEAT_INTERVAL_MS = 30_000;
const RECONCILIATION_ATTEMPT_TIMEOUT_MS = 60_000;
class ReconciliationLeaseLostError extends Error {}

export class ReconcilePublicationOutcomes {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
    private readonly onFailure: (
      intentId: string,
      error: unknown,
    ) => void = () => undefined,
    private readonly attemptTimeoutMs = RECONCILIATION_ATTEMPT_TIMEOUT_MS,
  ) {}

  async execute(limit = 100): Promise<number> {
    const claims = await this.repository.unknownRemoteOutcomes(
      this.clock(),
      limit,
    );
    let reconciled = 0;
    const pending: Array<{
      claim: PublicationReconciliationClaim;
      reconcile: NonNullable<PublicationProvider["reconcile"]>;
      abortController: AbortController;
      heartbeat: ReturnType<typeof setInterval>;
    }> = [];
    for (const claim of claims) {
      const provider = this.providers.find(
        (candidate) =>
          candidate.platform === claim.platform && candidate.reconcile,
      );
      if (!provider?.reconcile) {
        await this.repository
          .releaseReconciliationClaim(claim)
          .catch((error: unknown) => this.onFailure(claim.id, error));
        continue;
      }
      const abortController = new AbortController();
      const heartbeat = this.startHeartbeat(claim, abortController);
      pending.push({
        claim,
        reconcile: provider.reconcile.bind(provider),
        abortController,
        heartbeat,
      });
    }
    for (const context of pending) {
      const { claim, reconcile, abortController, heartbeat } = context;
      const deadline = createAbortDeadline(
        abortController.signal,
        this.attemptTimeoutMs,
        "PUBLICATION_RECONCILIATION_TIMEOUT",
      );
      try {
        const result = await reconcile(claim, deadline.signal);
        let applied: boolean;
        if (result.state === "PENDING")
          applied = await this.repository.refreshUnknownRemoteState(
            claim,
            result.remoteStatus,
            this.clock(),
          );
        else if (result.state === "PUBLISHED")
          applied = await this.repository.finalizePublished(
            claim,
            result,
            this.clock(),
          );
        else
          applied = await this.repository.failUnknownRemoteState(
            claim,
            result,
            this.clock(),
          );
        if (applied) reconciled += 1;
      } catch (error) {
        if (deadline.signal.reason instanceof ReconciliationLeaseLostError)
          continue;
        await this.repository
          .releaseReconciliationClaim(claim)
          .catch(() => undefined);
        this.onFailure(claim.id, error);
      } finally {
        deadline.dispose();
        clearInterval(heartbeat);
      }
    }
    return reconciled;
  }

  private startHeartbeat(
    claim: PublicationReconciliationClaim,
    abortController: AbortController,
  ): ReturnType<typeof setInterval> {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.repository
        .heartbeatReconciliationClaim(claim, this.clock())
        .then((retained) => {
          if (!retained && !abortController.signal.aborted)
            abortController.abort(new ReconciliationLeaseLostError());
        })
        .catch(() => {
          // A database error makes lease ownership unknowable. Abort provider
          // polling so an expired claim cannot overlap a recovery worker.
          if (!abortController.signal.aborted)
            abortController.abort(new ReconciliationLeaseLostError());
        })
        .finally(() => {
          running = false;
        });
    }, RECONCILIATION_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}
