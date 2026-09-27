import type {
  PublicationClaim,
  PublicationProvider,
} from "../application/publication.port.js";

export const LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION =
  "local-publication-dry-run-v1" as const;

export class LocalDryRunPublicationAdapter implements PublicationProvider {
  readonly platform = "LOCAL_DRY_RUN" as const;

  async publish(claim: PublicationClaim) {
    return {
      adapterVersion: LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION,
      providerReceipt: {
        mode: "DRY_RUN",
        publicationIntentId: claim.id,
        contentKind: claim.contentKind,
        contentId: claim.contentId,
        metadataAccepted: true,
        externalWritePerformed: false,
      },
      publicUrl: null,
    };
  }
}
