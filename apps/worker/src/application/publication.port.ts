import type {
  PublicationContentKind,
  PublicationPlatform,
} from "@content-factory/contracts";

export interface PublicationClaim {
  id: string;
  platform: PublicationPlatform;
  contentKind: PublicationContentKind;
  contentId: string;
  metadataSnapshot: Record<string, unknown>;
  attemptNumber: number;
}

export interface PublicationAdapterResult {
  adapterVersion: string;
  providerReceipt: Record<string, unknown>;
  publicUrl: string | null;
}

export interface PublicationWorkerRepository {
  claim(intentId: string, now: Date): Promise<PublicationClaim | null>;
  finalizeDryRun(
    claim: PublicationClaim,
    result: PublicationAdapterResult,
    now: Date,
  ): Promise<void>;
  failFinal(
    claim: PublicationClaim,
    code: string,
    message: string,
    now: Date,
  ): Promise<void>;
  markUnknownRemoteState(
    claim: PublicationClaim,
    code: string,
    message: string,
    now: Date,
  ): Promise<void>;
}

export interface PublicationProvider {
  readonly platform: PublicationPlatform;
  publish(claim: PublicationClaim): Promise<PublicationAdapterResult>;
}

/** The provider may have committed remotely, so automatic POST retry is unsafe. */
export class PublicationOutcomeUnknownError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationOutcomeUnknownError";
  }
}
