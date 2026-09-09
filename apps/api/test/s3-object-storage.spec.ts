import { S3ServiceException, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3ObjectStorage } from "../src/projects/infrastructure/s3-object-storage.js";
import { ObjectRangeNotSatisfiableError } from "../src/projects/application/object-storage.port.js";

afterEach(() => {
  delete process.env.S3_STARTUP_TIMEOUT_MS;
});

describe("S3ObjectStorage startup", () => {
  it("fails deterministically when the startup probe exceeds its short timeout", async () => {
    process.env.S3_STARTUP_TIMEOUT_MS = "1";
    const client = {
      send: vi.fn(() => new Promise(() => undefined)),
      destroy: vi.fn(),
    } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);

    await expect(storage.ensurePrivateBucket()).rejects.toThrow(
      "S3_STARTUP_TIMEOUT",
    );
    storage.onModuleDestroy();
  });

  it("normalizes a vendor InvalidRange response to the owned storage error", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(
        new S3ServiceException({
          name: "InvalidRange",
          $fault: "client",
          $metadata: { httpStatusCode: 416 },
        }),
      ),
      destroy: vi.fn(),
    } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);

    await expect(
      storage.readObject("private/source.mp4", "bytes=1000-"),
    ).rejects.toBeInstanceOf(ObjectRangeNotSatisfiableError);
    storage.onModuleDestroy();
  });
});
