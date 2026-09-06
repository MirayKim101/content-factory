import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProcessMediaJob,
  releaseAttemptResources,
} from "../src/application/process-media-job.js";
import type {
  MediaJobRepository,
  MediaJobTelemetry,
  MediaProcessor,
  AssemblyRenderer,
  PackageExporter,
  SourceCache,
  WorkerObjectStorage,
} from "../src/application/ports.js";
import type { ClaimedMediaJob } from "../src/domain/media-job.js";
import { ControlledMediaError } from "../src/domain/media-job.js";
import { StreamingZip64PackageExporter } from "../src/infrastructure/streaming-zip64-package-exporter.js";

function claimed<T extends "SOURCE_PROBE" | "CUT_SEGMENT">(
  type: T,
): Extract<ClaimedMediaJob, { type: T }> {
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
    queueWaitMs: 125,
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
  } as Extract<ClaimedMediaJob, { type: T }>;
}

function dependencies(job: ClaimedMediaJob) {
  const repository: MediaJobRepository = {
    getAssemblyResourcePlan: vi.fn(async () => null),
    deferAssemblyAdmission: vi.fn(async () => undefined),
    prepareExportScratch: vi.fn(async () => undefined),
    clearExportScratch: vi.fn(async () => undefined),
    listActiveExportScratchReservations: vi.fn(async () => []),
    inspectExportScratchLease: vi.fn(async () => "INACTIVE" as const),
    clearReconciledExportScratch: vi.fn(async () => undefined),
    claim: vi.fn(async () => job),
    heartbeat: vi.fn(async () => true),
    updateAssemblyProgress: vi.fn(async () => true),
    isLeaseActive: vi.fn(async () => true),
    prepareAttemptOutput: vi.fn(async () => undefined),
    completeAttemptCleanup: vi.fn(async () => undefined),
    completeProbe: vi.fn(async () => undefined),
    completeMontageProbe: vi.fn(async () => undefined),
    completeCut: vi.fn(async () => undefined),
    completeAssembly: vi.fn(async () => undefined),
    completeEditorialExport: vi.fn(async () => undefined),
    isAssemblyResultAccepted: vi.fn(async () => false),
    isEditorialExportResultAccepted: vi.fn(async () => false),
    fail: vi.fn(async () => "FAILED_FINAL" as const),
    close: vi.fn(async () => undefined),
  };
  const storage: WorkerObjectStorage = {
    read: vi.fn(async () => Readable.from([Buffer.from("source")])),
    download: vi.fn(async (_key, destination) =>
      writeFile(destination, "source"),
    ),
    upload: vi.fn(async () => ({ etag: "etag" })),
    delete: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const processor: MediaProcessor = {
    inspectMontage: vi.fn(async () => ({
      schemaVersion: 1 as const,
      durationMs: 1000,
      width: 1280,
      height: 720,
      hasAudio: false,
      version: "ffprobe test",
    })),
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
  it("exports one lease-scoped package, persists real progress, and clears scratch", async () => {
    const job = exportJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1_048_576n,
    }));
    const exporter: PackageExporter = {
      export: vi.fn(async (input) => {
        input.onProgress({ phase: "READ_INPUTS", bytes: 6n, totalBytes: 9n });
        input.onProgress({ phase: "WRITE_ARCHIVE", bytes: 9n, totalBytes: 9n });
        await writeFile(input.outputPath, fakeMp4("ZIP"));
        return {
          manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
          archiveBytes: BigInt(fakeMp4("ZIP").length),
        };
      }),
    };
    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      undefined,
      exporter,
    ).execute(job.id);
    expect(deps.repository.prepareExportScratch).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        directoryName: expect.stringMatching(/^export-/),
        leaseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reservedBytes: 1_048_576n,
      }),
    );
    expect(deps.repository.prepareAttemptOutput).toHaveBeenCalledWith(
      job,
      expect.stringMatching(/\.zip$/),
    );
    expect(deps.repository.completeEditorialExport).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        filename: `editorial-package-${job.editorialExportPlan.intentId}.zip`,
        manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
      }),
    );
    expect(deps.repository.clearExportScratch).toHaveBeenCalledOnce();
    expect(deps.repository.updateAssemblyProgress).toHaveBeenCalledWith(
      job,
      "FINALIZE",
      9_900,
    );
    expect(deps.repository.fail).not.toHaveBeenCalled();
  });

  it("keeps persisted archive progress monotonic for the real interleaved exporter callbacks", async () => {
    const job = exportJob();
    const video = Buffer.from("ab");
    const thumbnail = Buffer.from("png");
    job.editorialExportPlan.video.sizeBytes = BigInt(video.length);
    job.editorialExportPlan.video.sha256 = createHash("sha256")
      .update(video)
      .digest("hex");
    job.editorialExportPlan.thumbnail.sizeBytes = BigInt(thumbnail.length);
    job.editorialExportPlan.thumbnail.sha256 = createHash("sha256")
      .update(thumbnail)
      .digest("hex");
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1_048_576n,
    }));
    deps.storage.read = vi.fn(async (objectKey) => {
      if (objectKey !== job.editorialExportPlan.video.objectKey) {
        return Readable.from([thumbnail]);
      }
      return Readable.from(
        (async function* slowVideo() {
          for (const byte of video) {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            yield Buffer.from([byte]);
          }
        })(),
      );
    });

    await worker(
      deps,
      3_000,
      undefined,
      undefined,
      undefined,
      new StreamingZip64PackageExporter(),
    ).execute(job.id);

    const archiveProgress = vi
      .mocked(deps.repository.updateAssemblyProgress)
      .mock.calls.filter(([, phase]) =>
        ["READ_INPUTS", "WRITE_ARCHIVE"].includes(phase),
      );
    const firstWrite = archiveProgress.findIndex(
      ([, phase]) => phase === "WRITE_ARCHIVE",
    );
    expect(firstWrite).toBeGreaterThan(0);
    expect(
      archiveProgress
        .slice(firstWrite + 1)
        .some(([, phase]) => phase === "READ_INPUTS"),
    ).toBe(false);
    expect(archiveProgress.map(([, , value]) => value)).toEqual(
      archiveProgress
        .map(([, , value]) => value)
        .toSorted((left, right) => left - right),
    );
  }, 10_000);

  it("does no export work for a duplicate delivery that cannot claim", async () => {
    const job = exportJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    deps.repository.claim = vi.fn(async () => null);
    const exporter = successfulPackageExporter();

    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      undefined,
      exporter,
    ).execute(job.id);

    expect(exporter.export).not.toHaveBeenCalled();
    expect(deps.repository.prepareExportScratch).not.toHaveBeenCalled();
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });

  it("cleans the reserved attempt object after export storage upload fails", async () => {
    const job = exportJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    deps.storage.upload = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    deps.repository.fail = vi.fn(async () => "RETRY_SCHEDULED" as const);

    await expect(
      worker(
        deps,
        30_000,
        undefined,
        undefined,
        undefined,
        successfulPackageExporter(),
      ).execute(job.id),
    ).rejects.toMatchObject({
      code: "MEDIA_PROCESSING_FAILED",
      retryable: true,
    });
    const outputKey = vi.mocked(deps.repository.prepareAttemptOutput).mock
      .calls[0]?.[1];
    expect(outputKey).toBeDefined();
    expect(deps.storage.delete).toHaveBeenCalledWith(outputKey);
    expect(deps.repository.completeAttemptCleanup).toHaveBeenCalledWith(
      job,
      outputKey,
    );
    expect(deps.repository.completeEditorialExport).not.toHaveBeenCalled();
  });

  it("preserves the authoritative export after an ambiguous finalize response", async () => {
    const job = exportJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    vi.mocked(deps.repository.completeEditorialExport).mockRejectedValueOnce(
      new Error("database response lost after commit"),
    );
    vi.mocked(
      deps.repository.isEditorialExportResultAccepted,
    ).mockResolvedValueOnce(true);

    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      undefined,
      successfulPackageExporter(),
    ).execute(job.id);

    expect(
      deps.repository.isEditorialExportResultAccepted,
    ).toHaveBeenCalledWith(job, expect.stringContaining("/editorial-exports/"));
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.repository.fail).not.toHaveBeenCalled();
  });

  it("deletes the attempt object when approval becomes stale after export claim", async () => {
    const job = exportJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    vi.mocked(deps.repository.completeEditorialExport).mockRejectedValueOnce(
      new ControlledMediaError(
        "EXPORT_APPROVAL_STALE",
        "The exact editorial approval is no longer current or authorized.",
        false,
      ),
    );

    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      undefined,
      successfulPackageExporter(),
    ).execute(job.id);

    const outputKey = vi.mocked(deps.repository.prepareAttemptOutput).mock
      .calls[0]?.[1];
    expect(deps.storage.delete).toHaveBeenCalledWith(outputKey);
    expect(deps.repository.completeAttemptCleanup).toHaveBeenCalledWith(
      job,
      outputKey,
    );
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "EXPORT_APPROVAL_STALE",
      expect.any(String),
      false,
    );
  });

  it("releases scratch reservation even when source and scratch cleanup fail", async () => {
    const calls: string[] = [];
    await expect(
      releaseAttemptResources(
        async () => {
          calls.push("source");
          throw new Error("source release failed");
        },
        async () => {
          calls.push("scratch");
          throw new Error("scratch removal failed");
        },
        () => calls.push("reservation"),
      ),
    ).rejects.toThrow("source release failed");
    expect(calls).toEqual(["source", "scratch", "reservation"]);
  });

  it("defers assembly before claim when scratch admission is exhausted", async () => {
    const job = assemblyJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 9_000_000_000_000_000n,
    }));
    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      assemblyRenderer(),
    ).execute(job.id);
    expect(deps.repository.deferAssemblyAdmission).toHaveBeenCalledWith(
      job.id,
      "INSUFFICIENT_SCRATCH",
      expect.any(Date),
    );
    expect(deps.repository.claim).not.toHaveBeenCalled();
  });

  it("downloads exact frozen assembly inputs and finalizes one attempt result", async () => {
    const job = assemblyJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    const renderer = assemblyRenderer();
    const events: Parameters<MediaJobTelemetry>[0][] = [];
    await worker(
      deps,
      30_000,
      (event) => events.push(event),
      undefined,
      renderer,
    ).execute(job.id);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.inspectOutput).toHaveBeenCalledOnce();
    expect(deps.repository.updateAssemblyProgress).toHaveBeenCalledWith(
      job,
      "OUTPUT_PROBE",
      8_700,
    );
    expect(
      vi.mocked(deps.repository.updateAssemblyProgress).mock
        .invocationCallOrder[
        vi
          .mocked(deps.repository.updateAssemblyProgress)
          .mock.calls.findIndex(([, phase]) => phase === "OUTPUT_PROBE")
      ],
    ).toBeLessThan(
      vi.mocked(renderer.inspectOutput).mock.invocationCallOrder[0]!,
    );
    expect(events.filter((event) => event.phase === "encode")).toHaveLength(1);
    expect(
      events.filter((event) => event.phase === "output_probe"),
    ).toHaveLength(1);
    expect(deps.repository.updateAssemblyProgress).toHaveBeenCalledWith(
      job,
      "FINALIZE",
      9_900,
    );
    expect(deps.repository.completeAssembly).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        filename: `horizontal-${job.assemblyRenderPlan.intentId}.mp4`,
        durationMs: 1_000,
      }),
    );
  });

  it("fails assembly terminally when a downloaded identity differs", async () => {
    const job = assemblyJob();
    job.assemblyRenderPlan.inputs[0]!.sha256 = "f".repeat(64);
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    const renderer = assemblyRenderer();
    await worker(deps, 30_000, undefined, undefined, renderer).execute(job.id);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "ASSEMBLY_INPUT_IDENTITY_MISMATCH",
      expect.any(String),
      false,
    );
  });

  it("fences assembly finalization and cleans the attempt object after lease loss", async () => {
    const job = assemblyJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    vi.mocked(deps.repository.isLeaseActive)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      assemblyRenderer(),
    ).execute(job.id);
    expect(deps.repository.prepareAttemptOutput).toHaveBeenCalledOnce();
    expect(deps.storage.upload).toHaveBeenCalledOnce();
    expect(deps.storage.delete).toHaveBeenCalledOnce();
    expect(deps.repository.completeAttemptCleanup).toHaveBeenCalledOnce();
    expect(deps.repository.completeAssembly).not.toHaveBeenCalled();
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "JOB_LEASE_LOST",
      expect.any(String),
      true,
    );
  });

  it("preserves an authoritative assembly object after an ambiguous finalize outcome", async () => {
    const job = assemblyJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    vi.mocked(deps.repository.completeAssembly).mockRejectedValueOnce(
      new Error("database response lost after commit"),
    );
    vi.mocked(deps.repository.isAssemblyResultAccepted).mockResolvedValueOnce(
      true,
    );
    await worker(
      deps,
      30_000,
      undefined,
      undefined,
      assemblyRenderer(),
    ).execute(job.id);
    expect(deps.repository.isAssemblyResultAccepted).toHaveBeenCalledWith(
      job,
      expect.stringContaining(`/assembly/${job.id}/attempt-1-`),
    );
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.repository.fail).not.toHaveBeenCalled();
  });

  it("defers cleanup when an ambiguous assembly finalize cannot be reread", async () => {
    const job = assemblyJob();
    const deps = dependencies(job);
    deps.repository.getAssemblyResourcePlan = vi.fn(async () => ({
      requiredScratchBytes: 1n,
    }));
    vi.mocked(deps.repository.completeAssembly).mockRejectedValueOnce(
      new Error("database response lost after commit"),
    );
    vi.mocked(deps.repository.isAssemblyResultAccepted).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      worker(deps, 30_000, undefined, undefined, assemblyRenderer()).execute(
        job.id,
      ),
    ).resolves.toBeUndefined();
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "ASSEMBLY_FINALIZE_OUTCOME_UNKNOWN",
      expect.any(String),
      true,
    );
  });

  it("probes montage bytes using the asset identity, never the VOD probe or cutter", async () => {
    const job: ClaimedMediaJob = {
      ...claimed("SOURCE_PROBE"),
      type: "MONTAGE_ASSET_PROBE",
      montageAssetId: "00000000-0000-4000-8000-000000000009",
      sourceObjectKey: "editorial/project/montage/asset/original",
      recipeVersion: "montage-asset-probe-v1",
    };
    const deps = dependencies(job);
    await worker(deps).execute(job.id);
    expect(deps.processor.inspectMontage).toHaveBeenCalledOnce();
    expect(deps.processor.probe).not.toHaveBeenCalled();
    expect(deps.processor.cut).not.toHaveBeenCalled();
    expect(deps.repository.completeMontageProbe).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ schemaVersion: 1, width: 1280 }),
    );
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });
  it("does not finalize a montage after losing its lease", async () => {
    const job: ClaimedMediaJob = {
      ...claimed("SOURCE_PROBE"),
      type: "MONTAGE_ASSET_PROBE",
      montageAssetId: "00000000-0000-4000-8000-000000000009",
    };
    const deps = dependencies(job);
    vi.mocked(deps.repository.isLeaseActive).mockResolvedValue(false);
    await worker(deps).execute(job.id);
    expect(deps.repository.completeMontageProbe).not.toHaveBeenCalled();
    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "JOB_LEASE_LOST",
      expect.any(String),
      true,
    );
  });
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
    expect(deps.processor.cut).toHaveBeenCalledWith(
      expect.objectContaining({ recipeVersion: "stage1-cut-h264-v1" }),
    );
    expect(deps.repository.prepareAttemptOutput).toHaveBeenCalledWith(
      job,
      expect.stringContaining("/attempt-1-"),
    );
    expect(deps.repository.completeCut).toHaveBeenCalledOnce();
  });

  it("records real phase timings without object keys or lease credentials", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    const events: Parameters<MediaJobTelemetry>[0][] = [];

    await worker(deps, 30_000, (event) => events.push(event)).execute(job.id);

    expect(events.map((event) => event.phase)).toEqual([
      "queue_wait",
      "cache_lookup",
      "source_download",
      "source_integrity_hash",
      "source_probe",
      "encode",
      "output_probe",
      "output_hash",
      "upload",
      "total",
    ]);
    expect(events.every((event) => event.durationMs >= 0)).toBe(true);
    expect(events[0]).toMatchObject({ phase: "queue_wait", durationMs: 125 });
    expect(events.at(-1)).toMatchObject({ outcome: "success" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(job.sourceObjectKey);
    expect(serialized).not.toContain(job.leaseToken);
    expect(serialized).not.toContain("objectKey");
  });

  it("does no work for a duplicate delivery that cannot claim the lease", async () => {
    const job = claimed("CUT_SEGMENT");
    const deps = dependencies(job);
    deps.repository.claim = vi.fn(async () => null);
    await worker(deps).execute(job.id);
    expect(deps.storage.download).not.toHaveBeenCalled();
    expect(deps.processor.cut).not.toHaveBeenCalled();
  });

  it("fails an unsupported cut recipe safely without retry or upload", async () => {
    const job = { ...claimed("CUT_SEGMENT"), recipeVersion: "unknown-v9" };
    const deps = dependencies(job);
    deps.processor.cut = vi.fn(async () => {
      throw new ControlledMediaError(
        "CUT_RECIPE_UNSUPPORTED",
        "Версия настроек обработки этого задания не поддерживается.",
        false,
      );
    });

    await worker(deps).execute(job.id);

    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "CUT_RECIPE_UNSUPPORTED",
      expect.any(String),
      false,
    );
    expect(deps.storage.upload).not.toHaveBeenCalled();
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

    const events: Parameters<MediaJobTelemetry>[0][] = [];
    await worker(deps, 30_000, (event) => events.push(event)).execute(job.id);

    expect(deps.repository.fail).toHaveBeenCalledWith(
      job,
      "CUT_OUTPUT_INVALID",
      expect.any(String),
      false,
    );
    expect(deps.storage.upload).not.toHaveBeenCalled();
    expect(deps.repository.completeCut).not.toHaveBeenCalled();
    expect(
      events.find((event) => event.phase === "output_probe"),
    ).toMatchObject({ outcome: "failure", failureCode: "CUT_OUTPUT_INVALID" });
    expect(events.at(-1)).toMatchObject({
      phase: "total",
      outcome: "failure",
      failureCode: "CUT_OUTPUT_INVALID",
    });
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
    const sourceCache = passthroughSourceCache();
    const acquire = sourceCache.acquire.bind(sourceCache);
    const release = vi.fn<() => Promise<void>>(async () => undefined);
    sourceCache.acquire = async (input) => {
      const handle = await acquire(input);
      release.mockImplementation(handle.release);
      return { ...handle, release };
    };
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

    await expect(
      worker(deps, 3_000, undefined, sourceCache).execute(job.id),
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(deps.storage.upload).not.toHaveBeenCalled();
    expect(deps.repository.completeCut).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
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
  telemetry?: MediaJobTelemetry,
  sourceCache: SourceCache = passthroughSourceCache(),
  renderer?: AssemblyRenderer,
  packageExporter?: PackageExporter,
): ProcessMediaJob {
  return new ProcessMediaJob(
    deps.repository,
    deps.storage,
    deps.processor,
    sourceCache,
    "worker-test",
    {
      scratchDirectory: tmpdir(),
      scratchSafetyBytes: 0n,
      leaseMs,
      jobTimeoutMs: 60_000,
      assemblyFontPath: "/tmp/test-font.ttf",
    },
    telemetry,
    renderer,
    packageExporter,
  );
}

function exportJob(): Extract<
  ClaimedMediaJob,
  { type: "EXPORT_EDITORIAL_PACKAGE" }
> {
  return {
    id: "00000000-0000-4000-8000-000000000021",
    type: "EXPORT_EDITORIAL_PACKAGE",
    projectId: "00000000-0000-4000-8000-000000000002",
    sourceId: "00000000-0000-4000-8000-000000000003",
    sourceVersion: 1,
    leaseToken: "00000000-0000-4000-8000-000000000004",
    attemptNumber: 1,
    queueWaitMs: 125,
    retryBudget: 2,
    recipeVersion: "editorial-export-zip-v1",
    editorialExportPlan: {
      intentId: "00000000-0000-4000-8000-000000000022",
      approvalId: "00000000-0000-4000-8000-000000000023",
      approvalContractVersion: "manual-horizontal-approval-v1",
      exportContractVersion: "editorial-export-zip-v1",
      candidateFingerprint: "a".repeat(64),
      editorialPackageRevisionId: "00000000-0000-4000-8000-000000000024",
      editorialRevision: 1,
      processingTemplateRevisionId: "00000000-0000-4000-8000-000000000025",
      recipeRevisionId: "00000000-0000-4000-8000-000000000026",
      recipeRevision: 1,
      configurationFingerprint: "b".repeat(64),
      assemblyRenderResultId: "00000000-0000-4000-8000-000000000027",
      renderContractVersion: "horizontal-render-v1",
      video: {
        artifactId: "00000000-0000-4000-8000-000000000028",
        objectKey: "video-key",
        sizeBytes: 6n,
        sha256: "c".repeat(64),
      },
      thumbnail: {
        assetId: "00000000-0000-4000-8000-000000000029",
        objectKey: "thumbnail-key",
        sizeBytes: 3n,
        sha256: "d".repeat(64),
        contentType: "image/png",
        originalFilename: "thumbnail.png",
      },
      metadata: {
        title: "Title",
        description: "Description",
        tags: ["one"],
      },
    },
  };
}

function successfulPackageExporter(): PackageExporter {
  return {
    export: vi.fn(async (input) => {
      await writeFile(input.outputPath, fakeMp4("ZIP"));
      return {
        manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
        archiveBytes: BigInt(fakeMp4("ZIP").length),
      };
    }),
  };
}

function assemblyJob(): Extract<
  ClaimedMediaJob,
  { type: "ASSEMBLE_HORIZONTAL" }
> {
  const id = "00000000-0000-4000-8000-000000000011";
  return {
    id,
    type: "ASSEMBLE_HORIZONTAL",
    projectId: "00000000-0000-4000-8000-000000000002",
    sourceId: "00000000-0000-4000-8000-000000000003",
    sourceVersion: 1,
    leaseToken: "00000000-0000-4000-8000-000000000004",
    attemptNumber: 1,
    queueWaitMs: 125,
    retryBudget: 2,
    recipeVersion: "horizontal-render-v1",
    assemblyRenderPlan: {
      intentId: "00000000-0000-4000-8000-000000000012",
      recipeRevisionId: "00000000-0000-4000-8000-000000000013",
      recipeRevision: 1,
      configurationFingerprint: "a".repeat(64),
      renderContractVersion: "horizontal-render-v1",
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
      expectedDurationMs: 1_000,
      advertisementInsertAtMs: null,
      cta: null,
      inputs: [
        {
          id: "00000000-0000-4000-8000-000000000014",
          role: "CUT",
          ordinal: 0,
          objectKey: "private/cut.mp4",
          sizeBytes: 6n,
          sha256: createHash("sha256").update("source").digest("hex"),
          durationMs: 1_000,
          hasAudio: true,
          startMs: null,
          endMs: null,
          position: null,
        },
      ],
    },
  };
}

function assemblyRenderer(): AssemblyRenderer {
  return {
    verifyCapabilities: vi.fn(async () => undefined),
    render: vi.fn(async (input) => {
      input.onProgress("AUDIO_ANALYSIS", 500);
      input.onProgress("ENCODE", 1_000);
      await writeFile(input.outputPath, fakeMp4("R"));
      return {
        canvas: {
          width: 1280,
          height: 720,
          fpsNumerator: 30,
          fpsDenominator: 1,
        },
        outputLoudness: {
          integratedLoudnessLufs: -14,
          truePeakDbtp: -1.5,
        },
      };
    }),
    inspectOutput: vi.fn(async () => ({
      durationMs: 1_000,
      width: 1280,
      height: 720,
      fpsNumerator: 30,
      fpsDenominator: 1,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 48_000,
      audioChannels: 2,
      ffmpegVersion: "ffmpeg test",
      ffprobeVersion: "ffprobe test",
      integratedLoudnessLufs: -14,
      truePeakDbtp: -1.5,
      normalizationProfileResult: "NORMALIZED",
    })),
  };
}

function passthroughSourceCache(): SourceCache {
  return {
    acquire: async (input) => {
      const directory = await mkdtemp(join(tmpdir(), "cf-source-cache-test-"));
      const path = join(directory, "source.mp4");
      input.onTelemetry?.({
        phase: "cache_lookup",
        durationMs: 0,
        outcome: "success",
        cacheOutcome: "miss",
        evictionCount: 0,
        evictedBytes: "0",
        currentCacheBytes: "0",
      });
      await input.fill(path, input.signal);
      input.onTelemetry?.({
        phase: "source_download",
        durationMs: 0,
        outcome: "success",
        bytes: input.identity.sizeBytes.toString(),
        cacheOutcome: "miss",
        currentCacheBytes: "0",
      });
      input.onTelemetry?.({
        phase: "source_integrity_hash",
        durationMs: 0,
        outcome: "success",
        bytes: input.identity.sizeBytes.toString(),
        cacheOutcome: "miss",
        currentCacheBytes: input.identity.sizeBytes.toString(),
      });
      return {
        path,
        outcome: "fill",
        probe: async (load, signal) => ({
          result: await load(signal),
          hit: false,
        }),
        release: async () => rm(directory, { recursive: true, force: true }),
      };
    },
    close: async () => undefined,
  };
}
