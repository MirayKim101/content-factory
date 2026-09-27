import type {
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";

export class ReconcilePublicationOutcomes {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
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
      if (!provider?.reconcile) continue;
      const result = await provider.reconcile(claim);
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
    }
    return reconciled;
  }
}
