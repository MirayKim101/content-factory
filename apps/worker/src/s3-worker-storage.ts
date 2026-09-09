import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { WorkerObjectStorage } from "@content-factory/manual-cut";

import type { WorkerEnvironment } from "./environment.js";

export class S3WorkerStorage implements WorkerObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: WorkerEnvironment["s3"]) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async downloadToFile(input: {
    objectKey: string;
    filePath: string;
    signal: AbortSignal;
    onProgress(progress: { current: bigint; total: bigint }): void;
  }): Promise<void> {
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
      }),
      { abortSignal: signal },
    );
    if (
      !result.Body ||
      !("pipe" in result.Body) ||
      result.ContentLength === undefined
    )
      throw new Error("STORAGE_SOURCE_STREAM_INVALID");
    const total = BigInt(result.ContentLength);
    let current = 0n;
    const body = result.Body as NodeJS.ReadableStream;
    body.on("data", (chunk: Buffer | Uint8Array) => {
      current += BigInt(chunk.byteLength);
      input.onProgress({ current, total });
    });
    await pipeline(
      body,
      createWriteStream(input.filePath, { flags: "wx", signal }),
      { signal },
    );
  }

  async putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
    signal: AbortSignal;
    onProgress(progress: { current: bigint; total: bigint }): void;
  }): Promise<{ etag?: string; version?: string }> {
    const file = await stat(input.filePath);
    const total = BigInt(file.size);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(
      () => abortController.abort(new Error("S3_OPERATION_TIMEOUT")),
      this.config.timeoutMs,
    );
    timer.unref();
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Body: createReadStream(input.filePath),
          ContentType: input.contentType,
          Metadata: { sha256: input.sha256 },
        },
        abortController,
        leavePartsOnError: false,
      });
      upload.on("httpUploadProgress", (event) => {
        if (event.loaded !== undefined)
          input.onProgress({ current: BigInt(event.loaded), total });
      });
      const result = await upload.done();
      return {
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { version: result.VersionId } : {}),
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
    }
  }

  async headObject(objectKey: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const operationSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
        : AbortSignal.timeout(this.config.timeoutMs);
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
        { abortSignal: operationSignal },
      );
      return true;
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.name === "NotFound" || error.$metadata.httpStatusCode === 404)
      )
        return false;
      throw error;
    }
  }

  async deleteObject(objectKey: string, signal?: AbortSignal): Promise<void> {
    const operationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
      : AbortSignal.timeout(this.config.timeoutMs);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      { abortSignal: operationSignal },
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}
