import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessMediaJob } from "../src/application/process-media-job.js";
import type {
  MediaJobRepository,
  MediaProcessor,
  WorkerObjectStorage,
} from "../src/application/ports.js";
import type { ClaimedMediaJob } from "../src/domain/media-job.js";

function claimed(type: ClaimedMediaJob["type"]): ClaimedMediaJob {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type,
    projectId: "00000000-0000-4000-8000-000000000002",
    sourceId: "00000000-0000-4000-8000-000000000003",
    sourceVersion: 1,
    sourceObjectKey: "sources/project/source.mp4",
    sourceSizeBytes: 1n,
    sourceSha256: "a".repeat(64),
    originalFilename: "source.mp4",
    leaseToken: "00000000-0000-4000-8000-000000000004",
    attemptNumber: 1,
    retryBudget: 2,
    recipeVersion: "stage1-cut-h264-v1",
    ...(type === "CUT_SEGMENT"
      ? {
          segment: {
            clientSegmentId: "00000000-0000-4000-8000-000000000005",
            startMs: 1_000,
            endMs: 2_000,
          },
        }
      : {}),
  };
}

function dependencies(job: ClaimedMediaJob) {
  const repository: MediaJobRepository = {
    claim: vi.fn(async () => job),
    heartbeat: vi.fn(async () => true),
    isLeaseActive: vi.fn(async () => true),
    prepareAttemptOutput: vi.fn(async () => undefined),
    completeAttemptCleanup: vi.fn(async () => undefined),
    completeProbe: vi.fn(async () => undefined),
    completeCut: vi.fn(async () => undefined),
    fail: vi.fn(async () => "FAILED_FINAL" as const),
    close: vi.fn(async () => undefined),
  };
  const storage: WorkerObjectStorage = {
    download: vi.fn(async (_key, destination) =>
      writeFile(destination, "source"),
    ),
    upload: vi.fn(async () => ({ etag: "etag" })),
    delete: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const processor: MediaProcessor = {
    probe: vi.fn(async () => ({ durationMs: 10_000, version: "ffprobe test" })),
    inspectOutput: vi.fn(async () => ({
      durationMs: 1_000,
      hasVideo: true,
      frameRate: 30,
      version: "ffprobe test",
    })),
    cut: vi.fn(async (input) => {
      input.onProgress(1_000);
      await writeFile(input.outputPath, fakeMp4("A"));
      return { version: "ffmpeg test" };
    }),
  };
  return { repository, storage, processor };
}

describe("ProcessMediaJob", () => {
  it("persists authoritative probe duration", async () => {
    const job = claimed("SOURCE_PROBE");
    const deps = dependencies(job);
    await worker(deps).execute(job.id);
    expect(deps.repository.completeProbe).toHaveBeenCalledWith(
      job,
      10_000,
      "ffprobe test",
    );
    expect(deps.repository.heartbeat).toHaveBeenCalledOnce();
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });

  it("uses an attempt-specific immutable key and validates the MP4 before upload", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    await worker(deps).execute(job.id);
    expect(deps.storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: `sources/${job.projectId}/results/${job.id}/attempt-1-${job.leaseToken}.mp4`,
      }),
    );
    expect(deps.processor.inspectOutput).toHaveBeenCalledOnce();
    expect(deps.repository.prepareAttemptOutput).toHaveBeenCalledWith(
      job,
      expect.stringContaining("/attempt-1-"),
    );
    expect(deps.repository.completeCut).toHaveBeenCalledOnce();
  });

  it("does no work for a duplicate delivery that cannot claim the lease", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.repository.claim = vi.fn(async () => null);
    await worker(deps).execute(job.id);
    expect(deps.storage.download).not.toHaveBeenCalled();
    expect(deps.processor.cut).not.toHaveBeenCalled();
  });

  it("persists a retryable controlled state after an infrastructure failure", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.storage.download = vi.fn(async () =>
      Promise.reject(new Error("storage unavailable")),
    );
    deps.repository.fail = vi.fn(async () => "RETRY_SCHEDULED" as const);
    await expect(worker(deps).execute(job.id)).rejects.toMatchObject({
      code: "MEDIA_PROCESSING_FAILED",
      retryable: true,
    });
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "MEDIA_PROCESSING_FAILED",
      expect.any(String),
      true,
    );
  });

  it("never uploads or finalizes output that fails post-encode inspection", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.processor.inspectOutput = vi.fn(async () => ({
      durationMs: 2_000,
      hasVideo: false,
      version: "ffprobe test",
    }));

    await worker(deps).execute(job.id);

    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "CUT_OUTPUT_INVALID",
      expect.any(String),
      false,
    );
    expect(deps.storage.upload).not.toHaveBeenCalled();
    expect(deps.repository.completeCut).not.toHaveBeenCalled();
  });

  it("deletes an attempt upload when finalization rejects a lost lease", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.repository.completeCut = vi.fn(async () => {
      throw new Error("JOB_LEASE_LOST");
    });
    deps.repository.fail = vi.fn(async () => "LEASE_LOST" as const);

    await expect(worker(deps).execute(job.id)).rejects.toMatchObject({
      code: "JOB_LEASE_LOST",
    });

    const upload = vi.mocked(deps.storage.upload).mock.calls[0]?.[0];
    expect(upload).toBeDefined();
    expect(deps.storage.delete).toHaveBeenCalledWith(upload?.objectKey);
    expect(deps.repository.completeCut).toHaveBeenCalledOnce();
  });

  it("aborts an active source download as soon as heartbeat loses the lease", async () => {
    const job = claimed("SOURCE_PROBE");
    const deps = dependencies(job);
    deps.repository.heartbeat = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    deps.repository.fail = vi.fn(async () => "LEASE_LOST" as const);
    deps.storage.download = vi.fn(
      async (_key, _destination, signal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const execution = worker(deps, 3_000).execute(job.id);

    await expect(execution).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(deps.processor.probe).not.toHaveBeenCalled();
  });

  it("aborts active FFmpeg work on lease loss before it can upload", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.repository.heartbeat = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    deps.repository.fail = vi.fn(async () => "LEASE_LOST" as const);
    deps.processor.cut = vi.fn(
      async (input) =>
        new Promise<{ version: string }>((_resolve, reject) => {
          if (input.signal.aborted) {
            reject(input.signal.reason);
            return;
          }
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
    );

    await expect(worker(deps, 3_000).execute(job.id)).rejects.toMatchObject({
      code: "JOB_LEASE_LOST",
    });
    expect(deps.storage.upload).not.toHaveBeenCalled();
    expect(deps.repository.completeCut).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeMp4(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(12, marker.charCodeAt(0)),
  ]);
}

function worker(
  deps: ReturnType<typeof dependencies>,
  leaseMs = 30_000,
): ProcessMediaJob {
  return new ProcessMediaJob(
    deps.repository,
    deps.storage,
    deps.processor,
    "worker-test",
    {
      scratchDirectory: tmpdir(),
      scratchSafetyBytes: 0n,
      leaseMs,
      jobTimeoutMs: 60_000,
    },
  );
}
