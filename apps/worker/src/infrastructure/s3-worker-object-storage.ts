import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ControlledMediaError } from "../domain/media-job.js";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type { WorkerObjectStorage } from "../application/ports.js";

export const SINGLE_REQUEST_UPLOAD_MAX_BYTES = 5_000_000_000n;

export class S3WorkerObjectStorage implements WorkerObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: {
      endpoint: string;
      region: string;
      accessKey: string;
      secretKey: string;
    },
  ) {
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

  async download(
    objectKey: string,
    destination: string,
    signal: AbortSignal,
    maxBytes?: bigint,
  ): Promise<void> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { abortSignal: signal },
    );
    if (!result.Body) throw new Error("SOURCE_OBJECT_BODY_MISSING");
    let transferred = 0n;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += BigInt(chunk.length);
        if (maxBytes !== undefined && transferred > maxBytes)
          callback(
            new ControlledMediaError(
              "MONTAGE_SIZE_MISMATCH",
              "Stored montage size exceeds its persisted identity.",
              false,
            ),
          );
        else callback(null, chunk);
      },
    });
    await pipeline(
      result.Body as NodeJS.ReadableStream,
      bounded,
      createWriteStream(destination),
      { signal },
    );
  }

  async read(
    objectKey: string,
    signal: AbortSignal,
  ): Promise<NodeJS.ReadableStream> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { abortSignal: signal },
    );
    if (!result.Body)
      throw new ControlledMediaError(
        "EXPORT_INPUT_MISSING",
        "An approved export input is missing from private storage.",
        false,
      );
    return result.Body as NodeJS.ReadableStream;
  }

  async upload(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    sizeBytes?: bigint;
    contentType?: string;
    uploadMode?: "MULTIPART" | "SINGLE_REQUEST";
    signal: AbortSignal;
    onProgress?(uploadedBytes: bigint): void;
  }): Promise<{ etag?: string; version?: string }> {
    if (input.uploadMode === "SINGLE_REQUEST") {
      return this.uploadSingleRequest(input);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: input.objectKey,
          Body: createReadStream(input.filePath),
          ContentType: input.contentType ?? "video/mp4",
          Metadata: { sha256: input.sha256 },
        },
        abortController: controller,
        leavePartsOnError: false,
      });
      if (input.onProgress) {
        upload.on("httpUploadProgress", (progress) => {
          if (progress.loaded !== undefined)
            input.onProgress?.(BigInt(progress.loaded));
        });
      }
      const result = await upload.done();
      return {
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { version: result.VersionId } : {}),
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  private async uploadSingleRequest(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    sizeBytes?: bigint;
    contentType?: string;
    signal: AbortSignal;
    onProgress?(uploadedBytes: bigint): void;
  }): Promise<{ etag?: string; version?: string }> {
    if (
      input.sizeBytes === undefined ||
      input.sizeBytes < 0n ||
      input.sizeBytes > SINGLE_REQUEST_UPLOAD_MAX_BYTES
    ) {
      throw new ControlledMediaError(
        "EXPORT_SINGLE_UPLOAD_LIMIT_EXCEEDED",
        "The export archive exceeds the safe atomic upload limit.",
        false,
      );
    }
    let uploaded = 0n;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploaded += BigInt(chunk.length);
        input.onProgress?.(uploaded);
        callback(null, chunk);
      },
    });
    const body = createReadStream(input.filePath).pipe(progress);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: body,
        ContentLength: Number(input.sizeBytes),
        ContentType: input.contentType ?? "application/zip",
        Metadata: { sha256: input.sha256 },
      }),
      { abortSignal: input.signal },
    );
    return {
      ...(result.ETag ? { etag: result.ETag } : {}),
      ...(result.VersionId ? { version: result.VersionId } : {}),
    };
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}
