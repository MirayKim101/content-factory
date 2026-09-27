import type { PublicationPlatform } from "@content-factory/contracts";

export interface PublicationClaim {
  id: string;
  platform: PublicationPlatform;
  exportResultId: string;
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
}

export interface PublicationProvider {
  readonly platform: PublicationPlatform;
  publish(claim: PublicationClaim): Promise<PublicationAdapterResult>;
}
