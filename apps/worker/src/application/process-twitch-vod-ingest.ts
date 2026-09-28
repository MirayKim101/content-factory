import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createAbortDeadline } from "./abort-deadline.js";
import type { TwitchVodMediaProvider } from "./twitch-vod-media.port.js";
import type { TwitchVodIngestRepository } from "./twitch-vod-ingest.port.js";
import type { WorkerObjectStorage } from "./ports.js";

class TwitchVodIngestLeaseLostError extends Error {}
class TwitchVodIngestShutdownError extends Error {}

export class ProcessTwitchVodIngest {
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    private readonly repository: TwitchVodIngestRepository,
    private readonly media: TwitchVodMediaProvider,
    private readonly storage: WorkerObjectStorage,
    private readonly scratchDirectory: string,
    private readonly maxBytes: bigint,
    private readonly leaseMs: number,
    private readonly attemptTimeoutMs = 24 * 60 * 60 * 1_000,
  ) {}

  abortAll(): void {
    this.stopping = true;
    for (const controller of this.activeControllers)
      controller.abort(new TwitchVodIngestShutdownError());
  }

  async execute(workerId: string): Promise<boolean> {
    if (this.stopping) return false;
    const lease = await this.repository.claimNext(workerId, this.leaseMs);
    if (!lease) return false;
    if (this.stopping) {
      await this.repository.release(lease.id, workerId).catch(() => false);
      return false;
    }
    const path = join(
      this.scratchDirectory,
      "twitch-ingest",
      `${lease.id}.part`,
    );
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const deadline = createAbortDeadline(
      controller.signal,
      this.attemptTimeoutMs,
      "TWITCH_VOD_INGEST_TIMEOUT",
    );
    const heartbeat = this.startHeartbeat(lease.id, workerId, controller);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const offset = await stat(path)
        .then((value) => BigInt(value.size))
        .catch(() => 0n);
      let expectedBytes = lease.totalBytes;
      if (
        offset > this.maxBytes ||
        (expectedBytes !== null && expectedBytes > this.maxBytes)
      )
        throw new Error("TWITCH_VOD_TOO_LARGE");
      if (lease.totalBytes === null || offset !== lease.totalBytes) {
        const response = await this.media.open(
          lease.providerVideoId,
          offset,
          deadline.signal,
        );
        try {
          if (response.totalSizeBytes > this.maxBytes)
            throw new Error("TWITCH_VOD_TOO_LARGE");
          expectedBytes = response.totalSizeBytes;
          await this.repository.checkpoint(
            lease.id,
            workerId,
            offset,
            response.totalSizeBytes,
          );
          let downloaded = offset;
          let persisted = offset;
          const checkpointBytes = 8n * 1024n * 1024n;
          const progress = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
              downloaded += BigInt(chunk.length);
              if (
                downloaded > response.totalSizeBytes ||
                downloaded > this.maxBytes
              ) {
                callback(new Error("TWITCH_VOD_SIZE_MISMATCH"));
                return;
              }
              if (downloaded - persisted < checkpointBytes) {
                callback(null, chunk);
                return;
              }
              this.repository
                .checkpoint(
                  lease.id,
                  workerId,
                  downloaded,
                  response.totalSizeBytes,
                )
                .then(() => {
                  persisted = downloaded;
                  callback(null, chunk);
                }, callback);
            },
          });
          await pipeline(
            Readable.from(response.body as AsyncIterable<Uint8Array>),
            progress,
            createWriteStream(path, {
              flags: offset > 0n ? "a" : "w",
              mode: 0o600,
            }),
            { signal: deadline.signal },
          );
        } catch (error) {
          await response.body.cancel(error).catch(() => undefined);
          throw error;
        }
      }
      const sizeBytes = BigInt((await stat(path)).size);
      if (expectedBytes === null || sizeBytes !== expectedBytes)
        throw new Error("TWITCH_VOD_SIZE_MISMATCH");
      await this.assertMp4(path);
      const sha256 = await this.hash(path, deadline.signal);
      await this.repository.checkpoint(
        lease.id,
        workerId,
        sizeBytes,
        sizeBytes,
      );
      const projectId = this.stableUuid(lease.id, "project");
      const sourceId = this.stableUuid(lease.id, "source");
      const artifactId = this.stableUuid(lease.id, "artifact");
      const objectKey = `sources/${projectId}/source-v1.mp4`;
      await this.repository.beginUpload(lease.id, workerId, objectKey, sha256);
      const receipt = await this.storage.upload({
        objectKey,
        filePath: path,
        sha256,
        sizeBytes,
        contentType: "video/mp4",
        uploadMode: "MULTIPART",
        signal: deadline.signal,
      });
      await this.repository.complete({
        intentId: lease.id,
        workerId,
        projectId,
        sourceId,
        artifactId,
        objectKey,
        sizeBytes,
        sha256,
        ...receipt,
      });
      await unlink(path).catch(() => undefined);
      return true;
    } catch (error) {
      if (isTwitchVodIngestLeaseLost(error)) return false;
      if (controller.signal.reason instanceof TwitchVodIngestLeaseLostError)
        return false;
      if (controller.signal.reason instanceof TwitchVodIngestShutdownError) {
        await this.repository.release(lease.id, workerId).catch(() => false);
        return false;
      }
      const deadlineReason = deadline.signal.reason;
      const code =
        deadline.signal.aborted && deadlineReason instanceof Error
          ? deadlineReason.message
          : error instanceof Error
            ? error.message
            : "TWITCH_VOD_INGEST_FAILED";
      const retryable =
        lease.attemptCount < 3 &&
        code !== "TWITCH_VOD_MP4_INVALID" &&
        code !== "TWITCH_VOD_TOO_LARGE";
      try {
        await this.repository.fail(
          lease.id,
          workerId,
          code.slice(0, 100),
          "Twitch VOD import failed.",
          retryable,
        );
      } catch (failure) {
        if (isTwitchVodIngestLeaseLost(failure)) return false;
        throw failure;
      }
      if (!retryable) await unlink(path).catch(() => undefined);
      return true;
    } finally {
      deadline.dispose();
      clearInterval(heartbeat);
      this.activeControllers.delete(controller);
    }
  }

  private startHeartbeat(
    id: string,
    workerId: string,
    controller: AbortController,
  ): ReturnType<typeof setInterval> {
    let running = false;
    const intervalMs = Math.max(1_000, Math.min(60_000, this.leaseMs / 3));
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.repository
        .heartbeat(id, workerId, this.leaseMs)
        .then((retained) => {
          if (!retained && !controller.signal.aborted)
            controller.abort(new TwitchVodIngestLeaseLostError());
        })
        .catch(() => {
          if (!controller.signal.aborted)
            controller.abort(new TwitchVodIngestLeaseLostError());
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    return timer;
  }

  private async assertMp4(path: string): Promise<void> {
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(12);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")
        throw new Error("TWITCH_VOD_MP4_INVALID");
    } finally {
      await file.close();
    }
  }

  private async hash(path: string, signal: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal }))
      hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  private stableUuid(intentId: string, purpose: string): string {
    const bytes = createHash("sha256")
      .update(`${intentId}:${purpose}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

function isTwitchVodIngestLeaseLost(error: unknown): boolean {
  return (
    error instanceof Error && error.message === "TWITCH_VOD_INGEST_LEASE_LOST"
  );
}
