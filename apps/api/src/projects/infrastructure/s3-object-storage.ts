import { createReadStream } from "node:fs";

import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import {
  apiEnvironment,
  type ApiEnvironment,
} from "../../config/environment.js";
import type {
  ObjectStorage,
  StoredObject,
} from "../application/object-storage.port.js";

export const S3_CLIENT = Symbol("S3_CLIENT");

@Injectable()
export class S3ObjectStorage
  implements ObjectStorage, OnModuleInit, OnModuleDestroy
{
  private readonly config: ApiEnvironment = apiEnvironment();
  private readonly client: S3Client;

  constructor(@Optional() @Inject(S3_CLIENT) client?: S3Client) {
    this.client =
      client ??
      new S3Client({
        endpoint: this.config.s3Endpoint,
        region: this.config.s3Region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: this.config.s3AccessKey,
          secretAccessKey: this.config.s3SecretKey,
        },
      });
  }

  async onModuleInit(): Promise<void> {
    await this.ensurePrivateBucket();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async ensurePrivateBucket(): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("S3_STARTUP_TIMEOUT"));
          controller.abort(new Error("S3_STARTUP_TIMEOUT"));
        }, this.config.storageStartupTimeoutMs);
        timer.unref();
      });
      await Promise.race([
        this.client.send(
          new HeadBucketCommand({ Bucket: this.config.sourceBucket }),
          {
            abortSignal: controller.signal,
          },
        ),
        timeout,
      ]);
    } catch (error) {
      if (this.isNotFound(error))
        throw new Error("S3_SOURCE_BUCKET_NOT_PROVISIONED");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<StoredObject> {
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(new Error("S3_OPERATION_TIMEOUT")),
      this.config.storageTimeoutMs,
    );
    const abortFromCaller = (): void =>
      abortController.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.config.sourceBucket,
          Key: input.objectKey,
          Body: createReadStream(input.filePath),
          ContentType: input.contentType,
          Metadata: { sha256: input.sha256 },
        },
        abortController,
        leavePartsOnError: false,
      });
      const result = await upload.done();
      return {
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { version: result.VersionId } : {}),
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async headObject(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.sourceBucket,
          Key: objectKey,
        }),
        { abortSignal: this.operationSignal(signal) },
      );
      return {
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { version: result.VersionId } : {}),
        ...(result.ContentLength === undefined
          ? {}
          : { sizeBytes: result.ContentLength }),
        ...(result.Metadata?.sha256 ? { sha256: result.Metadata.sha256 } : {}),
      };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(objectKey: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.sourceBucket,
        Key: objectKey,
      }),
      { abortSignal: this.operationSignal(signal) },
    );
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.storageTimeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private isNotFound(error: unknown): boolean {
    return (
      error instanceof S3ServiceException &&
      (error.name === "NotFound" || error.$metadata.httpStatusCode === 404)
    );
  }
}
