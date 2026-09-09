import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  S3WorkerObjectStorage,
  SINGLE_REQUEST_UPLOAD_MAX_BYTES,
} from "../src/infrastructure/s3-worker-object-storage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3 worker object storage export upload", () => {
  it("uses one atomic streaming PutObject request for an export archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-export-put-object-"));
    directories.push(directory);
    const path = join(directory, "package.zip");
    const bytes = Buffer.from("streamed-package");
    await writeFile(path, bytes);
    const storage = new S3WorkerObjectStorage("private", {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      accessKey: "test",
      secretKey: "test-secret",
    });
    const send = vi.fn(async (command: PutObjectCommand) => {
      const received: Buffer[] = [];
      for await (const chunk of command.input.Body as NodeJS.ReadableStream) {
        received.push(Buffer.from(chunk as Buffer));
      }
      expect(Buffer.concat(received)).toEqual(bytes);
      return { ETag: '"single-etag"', VersionId: "single-version" };
    });
    (
      storage as unknown as {
        client: { send: typeof send; destroy(): void };
      }
    ).client.send = send;
    const progress: bigint[] = [];

    await expect(
      storage.upload({
        objectKey: `private/${randomUUID()}.zip`,
        filePath: path,
        sha256: "a".repeat(64),
        sizeBytes: BigInt(bytes.length),
        contentType: "application/zip",
        uploadMode: "SINGLE_REQUEST",
        signal: new AbortController().signal,
        onProgress: (value) => progress.push(value),
      }),
    ).resolves.toEqual({
      etag: '"single-etag"',
      version: "single-version",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]![0].input.ContentLength).toBe(bytes.length);
    expect(progress.at(-1)).toBe(BigInt(bytes.length));
    storage.close();
  });

  it("rejects an archive above the atomic single-request limit before I/O", async () => {
    const storage = new S3WorkerObjectStorage("private", {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      accessKey: "test",
      secretKey: "test-secret",
    });
    const send = vi.fn();
    (
      storage as unknown as {
        client: { send: typeof send; destroy(): void };
      }
    ).client.send = send;

    await expect(
      storage.upload({
        objectKey: "private/too-large.zip",
        filePath: "/path-is-never-opened",
        sha256: "a".repeat(64),
        sizeBytes: SINGLE_REQUEST_UPLOAD_MAX_BYTES + 1n,
        uploadMode: "SINGLE_REQUEST",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "EXPORT_SINGLE_UPLOAD_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(send).not.toHaveBeenCalled();
    storage.close();
  });
});
