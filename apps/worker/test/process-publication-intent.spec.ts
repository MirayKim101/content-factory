import { describe, expect, it, vi } from "vitest";

import { ProcessPublicationIntent } from "../src/application/process-publication-intent.js";
import type {
  PublicationClaim,
  PublicationWorkerRepository,
} from "../src/application/publication.port.js";
import {
  LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION,
  LocalDryRunPublicationAdapter,
} from "../src/infrastructure/local-dry-run-publication-adapter.js";

const claim: PublicationClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  platform: "LOCAL_DRY_RUN",
  exportResultId: "00000000-0000-4000-8000-000000000002",
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    finalizeDryRun: vi.fn(),
    failFinal: vi.fn(),
  };
}

describe("ProcessPublicationIntent", () => {
  it("turns duplicate delivery into one durable dry-run result", async () => {
    const repo = repository();
    const process = new ProcessPublicationIntent(
      repo,
      [new LocalDryRunPublicationAdapter()],
      () => new Date("2026-10-01T09:00:00.000Z"),
    );
    await expect(process.execute(claim.id)).resolves.toBe(true);
    await expect(process.execute(claim.id)).resolves.toBe(false);
    expect(repo.finalizeDryRun).toHaveBeenCalledTimes(1);
    expect(repo.finalizeDryRun).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        adapterVersion: LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION,
        providerReceipt: expect.objectContaining({
          externalWritePerformed: false,
        }),
        publicUrl: null,
      }),
      new Date("2026-10-01T09:00:00.000Z"),
    );
  });

  it("fails closed when no provider is admitted", async () => {
    const repo = repository();
    const process = new ProcessPublicationIntent(repo, []);
    await expect(process.execute(claim.id)).resolves.toBe(true);
    expect(repo.failFinal).toHaveBeenCalledWith(
      claim,
      "PUBLICATION_PROVIDER_UNAVAILABLE",
      expect.any(String),
      expect.any(Date),
    );
  });
});
