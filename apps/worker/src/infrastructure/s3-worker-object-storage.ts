import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ControlledMediaError } from "../domain/media-job.js";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type { WorkerObjectStorage } from "../application/ports.js";

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

  async upload(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    signal: AbortSignal;
  }): Promise<{ etag?: string; version?: string }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: input.objectKey,
          Body: createReadStream(input.filePath),
          ContentType: "video/mp4",
          Metadata: { sha256: input.sha256 },
        },
        abortController: controller,
        leavePartsOnError: false,
      });
      const result = await upload.done();
      return {
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { version: result.VersionId } : {}),
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
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
