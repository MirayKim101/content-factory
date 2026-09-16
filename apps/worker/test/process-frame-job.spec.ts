import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessFrameJob } from "../src/application/process-frame-job.js";
import type {
  FrameJobRepository,
  ClaimedFrameWork,
  FrameWorkPlan,
} from "../src/application/frame-job-repository.port.js";
import type {
  FrameExtractor,
  FrameExtractionRequest,
} from "../src/application/frame-extractor.port.js";
import type { WorkerObjectStorage } from "../src/application/ports.js";
import { ControlledMediaError } from "../src/domain/media-job.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function setup() {
  const scratch = await mkdtemp(
    join(tmpdir(), "content-factory-frame-process-test-"),
  );
  directories.push(scratch);
  const events: string[] = [];
  const source = Buffer.from("exact immutable input");
  const plan: FrameWorkPlan = {
    intentId: randomUUID(),
    jobId: randomUUID(),
    inputObjectKey: "cut/exact",
    contextPolicyFingerprint: "f".repeat(64),
    capture: {
      projectId: randomUUID(),
      sourceId: randomUUID(),
      sourceVersion: 1,
      sourceSha256: "a".repeat(64),
      sourceAuthorizationRevision: 1,
      sourceAuthorizationBasis: "OPERATOR_ATTESTATION",
      sourceAuthorizationDeclarationVersion: "v1",
      sourceAuthorizationDecidedAt: new Date().toISOString(),
      cutPipelineJobId: randomUUID(),
      cutResultArtifactId: randomUUID(),
      cutResultSha256: createHash("sha256").update(source).digest("hex"),
      cutResultSizeBytes: String(source.length),
      cutStartMs: 1000,
      cutEndMs: 4000,
      creatorProfileId: randomUUID(),
      creatorProfileRevisionId: randomUUID(),
      creatorProfileRevisionNo: 1,
      sourceContextId: randomUUID(),
      sourceContextRevisionId: randomUUID(),
      sourceContextRevisionNo: 1,
      cutPromptId: randomUUID(),
      cutPromptRevisionId: randomUUID(),
      cutPromptRevisionNo: 1,
    },
  };
  const work: ClaimedFrameWork = {
    ...plan,
    attemptId: randomUUID(),
    attemptNumber: 1,
    leaseToken: randomUUID(),
    workDeadlineAt: new Date(Date.now() + 300_000),
    scratchDirectoryName: "",
    scratchReservedBytes: 0,
  };
  const repository = {
    initializePool: vi.fn(),
    close: vi.fn(),
    plan: vi.fn(async () => plan),
    claim: vi.fn(
      async (
        input: Parameters<FrameJobRepository["claim"]>[0],
      ): Promise<ClaimedFrameWork | null> => ({
        ...work,
        scratchDirectoryName: input.scratchDirectoryName,
        scratchReservedBytes: input.scratchReservedBytes,
      }),
    ),
    rejectPending: vi.fn(),
    heartbeat: vi.fn(async () => true),
    admitInputRead: vi.fn(async () => {
      events.push("admit-input");
    }),
    progress: vi.fn(),
    prepareOutput: vi.fn(async (_work, ordinal) => {
      events.push(`prepare-${ordinal}`);
      return {
        id: randomUUID(),
        ordinal,
        objectKey: `owned/attempt1/${ordinal}`,
      };
    }),
    uploadSettled: vi.fn(async (_work, output) => {
      events.push(`settled-${output.ordinal}`);
    }),
    uploaded: vi.fn(async (_work, output) => {
      events.push(`uploaded-${output.ordinal}`);
    }),
    finalize: vi.fn(async () => {
      events.push("finalize");
    }),
    accepted: vi.fn(async () => false),
    executionStopped: vi.fn(async () => {
      events.push("stopped");
    }),
    fail: vi.fn(async () => {
      events.push("failed");
    }),
    cleanupCandidates: vi.fn(async () => []),
    cleaned: vi.fn(),
    recover: vi.fn(),
    scratchCandidates: vi.fn(async () => []),
    scratchCleaned: vi.fn(),
  } satisfies FrameJobRepository;
  const storage = {
    read: vi.fn(),
    close: vi.fn(),
    delete: vi.fn(),
    download: vi.fn(
      async (_key: string, path: string, _signal: AbortSignal) => {
        events.push("download");
        await writeFile(path, source);
      },
    ),
    upload: vi.fn(async (input) => {
      events.push(`upload-${input.objectKey.split("/").at(-1)}`);
      return {};
    }),
  } satisfies WorkerObjectStorage;
  const extractor = {
    verifyAvailable: vi.fn(),
    extract: vi.fn(async (input: FrameExtractionRequest) => {
      const frames = [];
      for (const ordinal of [0, 1, 2]) {
        const filePath = join(input.outputDirectory, `${ordinal}.jpg`);
        await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const requested = [750, 1500, 2250][ordinal]!;
        frames.push({
          filePath,
          measurement: {
            ordinal,
            requestedCutMs: requested,
            requestedSourceMs: 1000 + requested,
            actualPtsTicks: requested * 1000,
            timeBaseNumerator: 1 as const,
            timeBaseDenominator: 1000000 as const,
            actualCutMs: requested,
            mappedSourceMs: 1000 + requested,
            width: 320,
            height: 240,
            sizeBytes: 4,
            sha256: "a".repeat(64),
            contentType: "image/jpeg" as const,
            recipeVersion: "quartiles-jpeg-640-v1" as const,
            extractorVersion: "ffmpeg-frame-extractor-v1" as const,
            ffmpegVersion: "ffmpeg version 5.1.9",
          },
        });
      }
      return frames;
    }),
  } satisfies FrameExtractor;
  const log = vi.fn();
  const processor = new ProcessFrameJob(
    repository,
    storage,
    extractor,
    "test-worker",
    {
      scratchDirectory: scratch,
      scratchSafetyBytes: 64 * 1024 * 1024,
      leaseMs: 300,
      workDeadlineMs: 300_000,
    },
    log,
  );
  return {
    processor,
    repository,
    storage,
    extractor,
    plan,
    work,
    events,
    log,
    scratch,
  };
}

describe("frame worker lifecycle and settlement fences", () => {
  it("gates the first byte, prepares every exact key before upload and stops after finalization", async () => {
    const f = await setup();
    expect(await f.processor.execute(f.plan.jobId)).toBe(true);
    expect(f.events).toEqual([
      "admit-input",
      "download",
      "prepare-0",
      "upload-0",
      "settled-0",
      "uploaded-0",
      "prepare-1",
      "upload-1",
      "settled-1",
      "uploaded-1",
      "prepare-2",
      "upload-2",
      "settled-2",
      "uploaded-2",
      "finalize",
      "stopped",
    ]);
    expect(f.storage.upload).toHaveBeenCalledTimes(3);
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.storage.download.mock.calls[0]?.[2]).toBe(
      f.extractor.extract.mock.calls[0]?.[0].signal,
    );
  });

  it("creates no scratch during a pending or unknown claim, including the preclaim crash boundary", async () => {
    const f = await setup();
    let rejectClaim!: (error: Error) => void;
    let claimBegan!: () => void;
    const began = new Promise<void>((resolve) => {
      claimBegan = resolve;
    });
    f.repository.claim.mockImplementationOnce(async (input) => {
      expect(input.scratchReservedBytes).toBeGreaterThan(0);
      expect(input.scratchDirectoryName).toMatch(/^content-factory-frames-/);
      claimBegan();
      return new Promise<never>((_resolve, reject) => {
        rejectClaim = reject;
      });
    });
    const execution = f.processor.execute(f.plan.jobId);
    const rejected = expect(execution).rejects.toThrow("claim outcome unknown");
    await began;
    // Inspect before any finally can run: SIGKILL here leaves no directory.
    expect(await readdir(f.scratch)).toEqual([]);
    rejectClaim(new Error("claim outcome unknown"));
    await rejected;
    expect(await readdir(f.scratch)).toEqual([]);
    expect(f.storage.download).not.toHaveBeenCalled();
  });

  it("creates only the durably claimed directory before the first read", async () => {
    const f = await setup();
    const claim = f.repository.claim.getMockImplementation()!;
    f.repository.claim.mockImplementationOnce(async (input) => {
      expect(await readdir(f.scratch)).toEqual([]);
      return claim(input);
    });
    f.repository.admitInputRead.mockImplementationOnce(async () => {
      const name = f.repository.claim.mock.calls[0]![0].scratchDirectoryName;
      expect(await readdir(f.scratch)).toEqual([name]);
    });
    await f.processor.execute(f.plan.jobId);
    expect(f.repository.finalize).toHaveBeenCalledOnce();
  });

  it("failed pre-read authorization touches no input or image bytes", async () => {
    const f = await setup();
    f.repository.admitInputRead.mockRejectedValue(
      new ControlledMediaError("FRAME_CONTEXT_STALE", "changed", false),
    );
    await f.processor.execute(f.plan.jobId);
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.extractor.extract).not.toHaveBeenCalled();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledWith(
      expect.any(Object),
      "FRAME_CONTEXT_STALE",
      "changed",
      false,
    );
    expect(f.events.at(-1)).toBe("stopped");
  });

  it("never fences execution stopped while a delayed upload is still pending after lease loss", async () => {
    const f = await setup();
    let uploaded!: () => void;
    let began!: () => void;
    let leaseLost!: () => void;
    const pendingUpload = new Promise<void>((resolve) => {
      uploaded = resolve;
    });
    const uploadBegan = new Promise<void>((resolve) => {
      began = resolve;
    });
    const lost = new Promise<void>((resolve) => {
      leaseLost = resolve;
    });
    f.storage.upload.mockImplementationOnce(async () => {
      began();
      await pendingUpload;
      return {};
    });
    f.repository.heartbeat.mockImplementation(async () => {
      leaseLost();
      return false;
    });
    const running = f.processor.execute(f.plan.jobId);
    await uploadBegan;
    await lost;
    expect(f.repository.executionStopped).not.toHaveBeenCalled();
    expect(f.repository.cleanupCandidates).not.toHaveBeenCalled();
    uploaded();
    await running;
    expect(f.repository.uploadSettled).toHaveBeenCalledTimes(1);
    expect(f.repository.uploaded).not.toHaveBeenCalled();
    expect(f.repository.executionStopped).toHaveBeenCalledTimes(1);
    expect(f.repository.fail).toHaveBeenCalledWith(
      expect.any(Object),
      "JOB_LEASE_LOST",
      expect.any(String),
      true,
    );
  });

  it("an ambiguous finalization read never authorizes destructive loser cleanup", async () => {
    const f = await setup();
    f.repository.finalize.mockRejectedValue(new Error("commit response lost"));
    f.repository.accepted.mockRejectedValue(new Error("database unavailable"));
    await f.processor.execute(f.plan.jobId);
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "frame_finalization_outcome_unknown" }),
    );
  });

  it("accepted commit after a lost response preserves every winning output", async () => {
    const f = await setup();
    f.repository.finalize.mockRejectedValue(new Error("commit response lost"));
    f.repository.accepted.mockResolvedValue(true);
    await f.processor.execute(f.plan.jobId);
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.repository.executionStopped).toHaveBeenCalledTimes(1);
  });

  it("partial upload failure never prepares or accepts a nonexistent third output", async () => {
    const f = await setup();
    f.storage.upload
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("network outcome unknown"));
    await f.processor.execute(f.plan.jobId);
    expect(f.repository.prepareOutput).toHaveBeenCalledTimes(2);
    expect(f.repository.uploadSettled).toHaveBeenCalledTimes(1);
    expect(f.repository.finalize).not.toHaveBeenCalled();
    expect(f.repository.executionStopped).toHaveBeenCalledTimes(1);
  });

  it("resource deferral performs no work and releases its unclaimed local scratch", async () => {
    const f = await setup();
    f.repository.claim.mockResolvedValue(null);
    await f.processor.execute(f.plan.jobId);
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(await readdir(f.scratch)).toEqual([]);
  });

  it("an absolute work deadline aborts the owned operation and is terminal", async () => {
    const f = await setup();
    f.work.workDeadlineAt = new Date(Date.now() + 75);
    f.extractor.extract.mockImplementation(async (input) => {
      await new Promise<never>((_resolve, reject) => {
        if (input.signal.aborted) reject(input.signal.reason);
        else
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
      });
      return [];
    });
    await f.processor.execute(f.plan.jobId);
    expect(f.repository.fail).toHaveBeenCalledWith(
      expect.any(Object),
      "FRAME_WORK_DEADLINE_EXCEEDED",
      expect.any(String),
      false,
    );
    expect(f.repository.finalize).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("stopped");
  });
});
