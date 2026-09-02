import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  EditorialIdempotencyConflictError,
  EditorialRevisionConflictError,
} from "../src/editorial-content/application/editorial-repository.port.js";
import type { EditorialPackageView } from "../src/editorial-content/domain/editorial.js";
import { PrismaEditorialRepository } from "../src/editorial-content/infrastructure/prisma-editorial.repository.js";
import type { PrismaService } from "../src/database/prisma.service.js";

describe("PrismaEditorialRepository transaction conflicts", () => {
  const saveInput = () => ({
    packageId: randomUUID(),
    revisionId: randomUUID(),
    mutationId: randomUUID(),
    pipelineJobId: randomUUID(),
    expectedRevision: 0,
    idempotencyKey: "editorial-retry-test",
    requestFingerprint: "a".repeat(64),
    processingTemplateRevisionId: randomUUID(),
    title: null,
    description: null,
    tags: null,
    thumbnailAssetId: null,
  });

  it("returns the committed same-body replay after a serialization conflict", async () => {
    const replay = {
      id: randomUUID(),
    } as unknown as EditorialPackageView;
    const transactionClient = {
      editorialMutationRequest: {
        findUnique: vi.fn().mockResolvedValue({
          requestFingerprint: "a".repeat(64),
          packageRevision: { packageId: replay.id, revision: 1 },
        }),
      },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementationOnce(
        (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      );
    const repository = new PrismaEditorialRepository({
      $transaction: transaction,
    } as unknown as PrismaService);
    const internals = repository as unknown as {
      findPackageRow: () => Promise<object>;
      mapPackage: () => EditorialPackageView;
    };
    vi.spyOn(internals, "findPackageRow").mockResolvedValue({});
    vi.spyOn(internals, "mapPackage").mockReturnValue(replay);

    await expect(repository.savePackage(saveInput())).resolves.toBe(replay);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps a different-body replay distinct after a serialization conflict", async () => {
    const transactionClient = {
      editorialMutationRequest: {
        findUnique: vi.fn().mockResolvedValue({
          requestFingerprint: "b".repeat(64),
          packageRevision: { packageId: randomUUID(), revision: 1 },
        }),
      },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementationOnce(
        (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      );
    const repository = new PrismaEditorialRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await expect(repository.savePackage(saveInput())).rejects.toBeInstanceOf(
      EditorialIdempotencyConflictError,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry an authoritative stale-CAS conflict", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValue(new EditorialRevisionConflictError());
    const repository = new PrismaEditorialRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await expect(repository.savePackage(saveInput())).rejects.toBeInstanceOf(
      EditorialRevisionConflictError,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("bounds and retries serialization conflicts before returning a stale-CAS conflict", async () => {
    const transaction = vi.fn().mockRejectedValue({ code: "P2034" });
    const repository = new PrismaEditorialRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await expect(repository.savePackage(saveInput())).rejects.toBeInstanceOf(
      EditorialRevisionConflictError,
    );
    expect(transaction).toHaveBeenCalledTimes(5);
  });
});
