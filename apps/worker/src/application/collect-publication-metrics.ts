import type {
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";
import { createAbortDeadline } from "./abort-deadline.js";

const METRICS_REQUEST_TIMEOUT_MS = 30_000;
const METRICS_HEARTBEAT_INTERVAL_MS = 30_000;
class MetricsLeaseLostError extends Error {}
class MetricsShutdownError extends Error {}

export class CollectPublicationMetrics {
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
    private readonly onFailure: (
      intentId: string,
      error: unknown,
    ) => void = () => undefined,
    private readonly requestTimeoutMs = METRICS_REQUEST_TIMEOUT_MS,
  ) {}

  abortAll(): void {
    this.stopping = true;
    for (const controller of this.activeControllers)
      controller.abort(new MetricsShutdownError());
  }

  async execute(limit = 50): Promise<number> {
    if (this.stopping) return 0;
    const claims = await this.repository.claimPublishedForMetrics(
      this.clock(),
      limit,
    );
    if (this.stopping) {
      await Promise.allSettled(
        claims.map((claim) => this.repository.releaseMetricsClaim(claim)),
      );
      return 0;
    }
    let collected = 0;
    const pending: Array<{
      claim: (typeof claims)[number];
      metrics: NonNullable<PublicationProvider["metrics"]>;
      abortController: AbortController;
      heartbeat: ReturnType<typeof setInterval>;
    }> = [];
    for (const claim of claims) {
      const provider = this.providers.find(
        (candidate) =>
          candidate.platform === claim.platform && candidate.metrics,
      );
      if (!provider?.metrics) {
        await this.repository.releaseMetricsClaim(claim).catch(() => undefined);
        continue;
      }
      const abortController = new AbortController();
      this.activeControllers.add(abortController);
      const heartbeat = this.startHeartbeat(claim, abortController);
      pending.push({
        claim,
        metrics: provider.metrics.bind(provider),
        abortController,
        heartbeat,
      });
    }
    for (const context of pending) {
      const { claim, metrics, abortController, heartbeat } = context;
      const deadline = createAbortDeadline(
        abortController.signal,
        this.requestTimeoutMs,
        "PUBLICATION_METRICS_TIMEOUT",
      );
      try {
        const snapshot = await metrics(claim, deadline.signal);
        deadline.signal.throwIfAborted();
        if (await this.repository.recordMetrics(claim, snapshot, this.clock()))
          collected += 1;
      } catch (error) {
        if (deadline.signal.reason instanceof MetricsLeaseLostError) continue;
        if (deadline.signal.reason instanceof MetricsShutdownError) {
          await this.repository
            .releaseMetricsClaim(claim)
            .catch(() => undefined);
          continue;
        }
        await this.repository.releaseMetricsClaim(claim).catch(() => undefined);
        this.onFailure(claim.id, error);
      } finally {
        deadline.dispose();
        clearInterval(heartbeat);
        this.activeControllers.delete(abortController);
      }
    }
    return collected;
  }

  private startHeartbeat(
    claim: Awaited<
      ReturnType<PublicationWorkerRepository["claimPublishedForMetrics"]>
    >[number],
    abortController: AbortController,
  ): ReturnType<typeof setInterval> {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.repository
        .heartbeatMetricsClaim(claim, this.clock())
        .then((retained) => {
          if (!retained && !abortController.signal.aborted)
            abortController.abort(new MetricsLeaseLostError());
        })
        .catch(() => {
          if (!abortController.signal.aborted)
            abortController.abort(new MetricsLeaseLostError());
        })
        .finally(() => {
          running = false;
        });
    }, METRICS_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}
