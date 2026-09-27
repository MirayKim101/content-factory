import type {
  PublicationContentKind,
  PublicationPlatform,
} from "@content-factory/contracts";

export interface PublicationClaim {
  id: string;
  channelId: string;
  externalChannelRef: string;
  platform: PublicationPlatform;
  contentKind: PublicationContentKind;
  contentId: string;
  contentObjectKey: string;
  contentSizeBytes: bigint;
  contentSha256: string;
  contentType: string;
  metadataSnapshot: Record<string, unknown>;
  attemptNumber: number;
}

export interface PublicationAdapterResult {
  adapterVersion: string;
  providerReceipt: Record<string, unknown>;
  publicUrl: string | null;
}

export interface PublicationReconciliationClaim extends PublicationClaim {
  remotePublicationId: string;
  reconciliationLeaseToken: string;
}

export type PublicationReconciliationResult =
  | {
      state: "PENDING";
      remoteStatus: string;
    }
  | {
      state: "PUBLISHED";
      remoteStatus: string;
      adapterVersion: string;
      providerReceipt: Record<string, unknown>;
      publicUrl: string | null;
    }
  | {
      state: "FAILED";
      remoteStatus: string;
      code: string;
      message: string;
    };

export interface PublicationWorkerRepository {
  claim(intentId: string, now: Date): Promise<PublicationClaim | null>;
  heartbeat(claim: PublicationClaim, now: Date): Promise<boolean>;
  finalizeDryRun(
    claim: PublicationClaim,
    result: PublicationAdapterResult,
    now: Date,
  ): Promise<void>;
  finalizePublishedDirect(
    claim: PublicationClaim,
    result: PublicationAdapterResult,
    now: Date,
  ): Promise<void>;
  releaseForRetry(
    claim: PublicationClaim,
    code: string,
    message: string,
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
    remotePublicationId: string | null,
    remoteStatus: string | null,
    now: Date,
  ): Promise<void>;
  unknownRemoteOutcomes(
    now: Date,
    limit?: number,
  ): Promise<PublicationReconciliationClaim[]>;
  refreshUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    remoteStatus: string,
    now: Date,
  ): Promise<void>;
  finalizePublished(
    claim: PublicationReconciliationClaim,
    result: Extract<PublicationReconciliationResult, { state: "PUBLISHED" }>,
    now: Date,
  ): Promise<void>;
  failUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    result: Extract<PublicationReconciliationResult, { state: "FAILED" }>,
    now: Date,
  ): Promise<void>;
  releaseReconciliationClaim(
    claim: PublicationReconciliationClaim,
  ): Promise<void>;
}

export interface PublicationProvider {
  readonly platform: PublicationPlatform;
  publish(
    claim: PublicationClaim,
    signal?: AbortSignal,
  ): Promise<PublicationAdapterResult>;
  reconcile?(
    claim: PublicationReconciliationClaim,
  ): Promise<PublicationReconciliationResult>;
}

/** The provider may have committed remotely, so automatic POST retry is unsafe. */
export class PublicationOutcomeUnknownError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remotePublicationId: string | null = null,
    readonly remoteStatus: string | null = null,
  ) {
    super(message);
    this.name = "PublicationOutcomeUnknownError";
  }
}
