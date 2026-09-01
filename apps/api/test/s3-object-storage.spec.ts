import type { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3ObjectStorage } from "../src/projects/infrastructure/s3-object-storage.js";

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
});
