import type {
  PublicationProvider,
  PublicationWorkerRepository,
} from "./publication.port.js";
import { PublicationOutcomeUnknownError } from "./publication.port.js";

export class ProcessPublicationIntent {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly providers: readonly PublicationProvider[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(intentId: string): Promise<boolean> {
    const claim = await this.repository.claim(intentId, this.clock());
    if (!claim) return false;
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
    try {
      const result = await provider.publish(claim);
      if (claim.platform === "LOCAL_DRY_RUN")
        await this.repository.finalizeDryRun(claim, result, this.clock());
      else
        await this.repository.finalizePublishedDirect(
          claim,
          result,
          this.clock(),
        );
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
}
