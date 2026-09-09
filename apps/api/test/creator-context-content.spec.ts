import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";

import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { CreatorContextRepository } from "../src/ai-content/application/creator-context-repository.port.js";
import type { CreatorContextStorage } from "../src/ai-content/application/creator-context-storage.port.js";
import type { CreatorContextService } from "../src/ai-content/application/creator-context.service.js";
import { CreatorContextController } from "../src/ai-content/presentation/creator-context.controller.js";
import { ObjectRangeNotSatisfiableError } from "../src/projects/application/object-storage.port.js";

const profileId = "8f727d08-1463-4a79-8d83-c51b553fd8ca";
const assetId = "d835d263-393a-421d-94f6-565849cc971c";
const now = new Date("2026-09-06T12:00:00.000Z");
const reference = {
  asset: {
    id: assetId,
    creatorProfileId: profileId,
    status: "READY" as const,
    originalFilename: "private-reference.png",
    contentType: "image/png" as const,
    sizeBytes: 6n,
    sha256: "a".repeat(64),
    width: 2,
    height: 1,
    currentAuthorization: {
      id: "5f9068bf-eebb-4085-95f0-d177648694ee",
      revision: 1,
      status: "NOT_REVIEWED" as const,
      declarationVersion: null,
      commercialAiImageUseAttested: false,
      basis: null,
      scope: null,
      expiresAt: null,
      externalProviderTransferAllowed: false,
      decidedAt: null,
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
  },
  objectKey: "private/internal/key.png",
};

describe("CreatorContextController private reference content", () => {
  it("streams one bounded range without exposing the object key", async () => {
    const storage = {
      readObject: vi.fn(async () => ({
        body: Readable.from(Buffer.from("bc")),
        contentLength: 2,
        contentType: "image/png",
        contentRange: "bytes 1-2/6",
      })),
    } as unknown as CreatorContextStorage;
    const repository = {
      getReference: vi.fn(async () => reference),
    } as unknown as CreatorContextRepository;
    const controller = new CreatorContextController(
      {} as CreatorContextService,
      repository,
      storage,
    );
    const headers = new Map<string, string>();
    const response = new PassThrough() as PassThrough & {
      statusCode: number;
      setHeader(name: string, value: string): void;
    };
    response.statusCode = 0;
    response.setHeader = (name, value) => headers.set(name, value);
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = once(response, "finish");

    await controller.referenceContent(
      profileId,
      assetId,
      "bytes=1-2",
      response as unknown as ServerResponse,
    );
    await finished;

    expect(response.statusCode).toBe(206);
    expect(Buffer.concat(chunks).toString()).toBe("bc");
    expect(headers.get("Content-Range")).toBe("bytes 1-2/6");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect([...headers.values()].join(" ")).not.toContain(reference.objectKey);
    expect(storage.readObject).toHaveBeenCalledWith(
      reference.objectKey,
      "bytes=1-2",
    );
  });

  it("maps an unsatisfiable storage range to a controlled 416", async () => {
    const storage = {
      readObject: vi.fn(async () => {
        throw new ObjectRangeNotSatisfiableError();
      }),
    } as unknown as CreatorContextStorage;
    const repository = {
      getReference: vi.fn(async () => reference),
    } as unknown as CreatorContextRepository;
    const controller = new CreatorContextController(
      {} as CreatorContextService,
      repository,
      storage,
    );
    const headers = new Map<string, string>();
    const response = new PassThrough() as PassThrough & {
      statusCode: number;
      setHeader(name: string, value: string): void;
    };
    response.setHeader = (name, value) => headers.set(name, value);

    let failure: unknown;
    try {
      await controller.referenceContent(
        profileId,
        assetId,
        "bytes=100-200",
        response as unknown as ServerResponse,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HttpException);
    const exception = failure as HttpException;
    expect(exception.getStatus()).toBe(416);
    expect(exception.getResponse()).toMatchObject({
      code: "RANGE_NOT_SATISFIABLE",
    });
    expect(headers.get("Content-Range")).toBe("bytes */6");
  });
});
