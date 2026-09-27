import type {
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";

const METRICS_REQUEST_TIMEOUT_MS = 30_000;

export class CollectPublicationMetrics {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
    private readonly onFailure: (
      intentId: string,
      error: unknown,
    ) => void = () => undefined,
  ) {}

  async execute(limit = 50): Promise<number> {
    const claims = await this.repository.claimPublishedForMetrics(
      this.clock(),
      limit,
    );
    let collected = 0;
    for (const claim of claims) {
      const provider = this.providers.find(
        (candidate) =>
          candidate.platform === claim.platform && candidate.metrics,
      );
      if (!provider?.metrics) {
        await this.repository.releaseMetricsClaim(claim).catch(() => undefined);
        continue;
      }
      try {
        const snapshot = await provider.metrics(
          claim,
          AbortSignal.timeout(METRICS_REQUEST_TIMEOUT_MS),
        );
        if (await this.repository.recordMetrics(claim, snapshot, this.clock()))
          collected += 1;
      } catch (error) {
        await this.repository.releaseMetricsClaim(claim).catch(() => undefined);
        this.onFailure(claim.id, error);
      }
    }
    return collected;
  }
}
