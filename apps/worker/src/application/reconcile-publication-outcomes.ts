import type {
  PublicationReconciliationClaim,
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";

const RECONCILIATION_HEARTBEAT_INTERVAL_MS = 30_000;
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
  ) {}

  async execute(limit = 100): Promise<number> {
    const claims = await this.repository.unknownRemoteOutcomes(
      this.clock(),
      limit,
    );
    let reconciled = 0;
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
      try {
        const result = await provider.reconcile(claim, abortController.signal);
        if (result.state === "PENDING")
          await this.repository.refreshUnknownRemoteState(
            claim,
            result.remoteStatus,
            this.clock(),
          );
        else if (result.state === "PUBLISHED")
          await this.repository.finalizePublished(claim, result, this.clock());
        else
          await this.repository.failUnknownRemoteState(
            claim,
            result,
            this.clock(),
          );
        reconciled += 1;
      } catch (error) {
        if (
          abortController.signal.reason instanceof ReconciliationLeaseLostError
        )
          continue;
        await this.repository
          .releaseReconciliationClaim(claim)
          .catch(() => undefined);
        this.onFailure(claim.id, error);
      } finally {
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
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, RECONCILIATION_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}
