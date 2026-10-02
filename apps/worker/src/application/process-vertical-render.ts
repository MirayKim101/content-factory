import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { WorkerObjectStorage } from "./ports.js";
import { createAbortDeadline } from "./abort-deadline.js";
import { deleteStorageObjectBestEffort } from "./bounded-storage-delete.js";
import type {
  VerticalRenderer,
  VerticalRenderRepository,
} from "./vertical-render.port.js";

class VerticalRenderShutdownError extends Error {}

export class ProcessVerticalRender {
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    private readonly repository: VerticalRenderRepository,
    private readonly storage: WorkerObjectStorage,
    private readonly renderer: VerticalRenderer,
    private readonly scratchRoot: string,
    private readonly leaseMs: number,
    private readonly attemptTimeoutMs = 2 * 60 * 60 * 1_000,
  ) {}

  abortAll(): void {
    this.stopping = true;
    for (const controller of this.activeControllers)
      controller.abort(new VerticalRenderShutdownError());
  }

  async execute(jobId: string): Promise<boolean> {
    if (this.stopping) return false;
    const claim = await this.repository.claim(jobId, this.leaseMs);
    if (!claim) return false;
    if (this.stopping) {
      await this.repository.release(claim).catch(() => false);
      return false;
    }
    const abort = new AbortController();
    this.activeControllers.add(abort);
    const deadline = createAbortDeadline(
      abort.signal,
      this.attemptTimeoutMs,
      "VERTICAL_RENDER_TIMEOUT",
    );
    let scratch: string | undefined;
    let heartbeatRunning = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatRunning || abort.signal.aborted) return;
        heartbeatRunning = true;
        void this.repository
          .heartbeat(claim, this.leaseMs)
          .then((active) => {
            if (!active) abort.abort(new Error("VERTICAL_LEASE_LOST"));
          })
          .catch(() => abort.abort(new Error("VERTICAL_HEARTBEAT_FAILED")))
          .finally(() => (heartbeatRunning = false));
      },
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      if (!(await this.repository.heartbeat(claim, this.leaseMs)))
        throw new Error("VERTICAL_LEASE_LOST");
      await mkdir(this.scratchRoot, { recursive: true });
      scratch = await mkdtemp(join(this.scratchRoot, "vertical-"));
      const input = join(scratch, "input.mp4");
      const output = join(scratch, "vertical.mp4");
      await this.storage.download(
        claim.inputObjectKey,
        input,
        deadline.signal,
        claim.inputSizeBytes,
      );
      const rendered = await this.renderer.render(
        input,
        output,
        deadline.signal,
      );
      if (
        rendered.width !== 1080 ||
        rendered.height !== 1920 ||
        rendered.videoCodec !== "h264" ||
        rendered.audioCodec !== "aac" ||
        Math.abs(rendered.durationMs - claim.expectedDurationMs) >
          Math.max(1_000, Math.ceil(claim.expectedDurationMs * 0.03))
      )
        throw new Error("VERTICAL_OUTPUT_INVALID");
      const file = await stat(output);
      if (!file.isFile() || file.size <= 0)
        throw new Error("VERTICAL_OUTPUT_EMPTY");
      const sha256 = await hashFile(output);
      const objectKey =
        `projects/${claim.projectId}/vertical/${claim.intentId}/attempts/` +
        `${claim.attemptNumber}-${claim.leaseToken}/${sha256}.mp4`;
      await this.repository.prepareOutput(claim, objectKey);
      const uploaded = await this.storage.upload({
        objectKey,
        filePath: output,
        sha256,
        sizeBytes: BigInt(file.size),
        contentType: "video/mp4",
        uploadMode: "MULTIPART",
        signal: deadline.signal,
      });
      const outputIdentity = {
        ...rendered,
        objectKey,
        sizeBytes: BigInt(file.size),
        sha256,
        etag: uploaded.etag,
        storageVersion: uploaded.version,
      };
      let completed: boolean;
      try {
        completed = await this.repository.complete(claim, outputIdentity);
      } catch (error) {
        try {
          if (await this.repository.completionMatches(claim, outputIdentity))
            return true;
        } catch {
          // The database commit outcome is unknown. The prepared JobAttempt
          // cleanup marker retains the exact object key; preserve the object
          // until the durable reconciler can distinguish committed output from
          // an orphan after PostgreSQL recovers.
          return false;
        }
        await deleteStorageObjectBestEffort(this.storage, objectKey);
        throw error;
      }
      if (!completed)
        await deleteStorageObjectBestEffort(this.storage, objectKey);
      return completed;
    } catch (error) {
      if (abort.signal.reason instanceof VerticalRenderShutdownError) {
        await this.repository.release(claim).catch(() => false);
        return false;
      }
      await this.repository.fail(
        claim,
        error instanceof Error
          ? error.message.slice(0, 120)
          : "VERTICAL_RENDER_FAILED",
        "Не удалось создать вертикальную версию.",
      );
      throw error;
    } finally {
      deadline.dispose();
      clearInterval(heartbeat);
      this.activeControllers.delete(abort);
      if (scratch)
        await rm(scratch, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}
