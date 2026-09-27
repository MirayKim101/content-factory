import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessVerticalRender } from "../src/application/process-vertical-render.js";
import type { WorkerObjectStorage } from "../src/application/ports.js";
import type {
  VerticalRenderer,
  VerticalRenderRepository,
} from "../src/application/vertical-render.port.js";

const directories: string[] = [];
const claim = {
  jobId: "job-1",
  intentId: "intent-1",
  projectId: "project-1",
  sourceId: "source-1",
  sourceVersion: 1,
  inputObjectKey: "cuts/input.mp4",
  inputSizeBytes: 5n,
  expectedDurationMs: 30_000,
  leaseToken: "lease-1",
  attemptNumber: 1,
  retryBudget: 2,
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function repository(overrides: Partial<VerticalRenderRepository> = {}) {
  return {
    claim: vi.fn().mockResolvedValue(claim),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn(),
    due: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    ...overrides,
  } satisfies VerticalRenderRepository;
}

function storage(): WorkerObjectStorage {
  return {
    read: vi.fn(),
    download: vi.fn(async (_key, destination) =>
      writeFile(destination, "input"),
    ),
    upload: vi.fn(async ({ filePath }) => {
      expect(await readFile(filePath, "utf8")).toBe("vertical-output");
      return { etag: "etag-1", version: "version-1" };
    }),
    delete: vi.fn(),
    close: vi.fn(),
  };
}

const renderer: VerticalRenderer = {
  render: vi.fn(async (_input, output) => {
    await writeFile(output, "vertical-output");
    return {
      durationMs: 30_000,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioCodec: "aac",
      ffmpegVersion: "ffmpeg-test",
    };
  }),
  verifyAvailable: vi.fn(),
};

describe("ProcessVerticalRender", () => {
  it("heartbeats before I/O and atomically accepts a valid portrait render", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository();
    const objectStorage = storage();
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      renderer,
      scratch,
      60_000,
    );

    await expect(process.execute(claim.jobId)).resolves.toBe(true);
    expect(repo.heartbeat).toHaveBeenCalledBefore(
      vi.mocked(objectStorage.download),
    );
    expect(repo.complete).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        width: 1080,
        height: 1920,
        sizeBytes: 15n,
        objectKey: expect.stringContaining("/attempts/1-lease-1/"),
      }),
    );
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("stops before object I/O when the lease is already lost", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository({ heartbeat: vi.fn().mockResolvedValue(false) });
    const objectStorage = storage();
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      renderer,
      scratch,
      60_000,
    );

    await expect(process.execute(claim.jobId)).rejects.toThrow(
      "VERTICAL_LEASE_LOST",
    );
    expect(objectStorage.download).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(
      claim,
      "VERTICAL_LEASE_LOST",
      expect.any(String),
    );
  });

  it("does nothing for a duplicate delivery after a terminal claim", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository({ claim: vi.fn().mockResolvedValue(null) });
    const objectStorage = storage();
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      renderer,
      scratch,
      60_000,
    );

    await expect(process.execute(claim.jobId)).resolves.toBe(false);
    expect(objectStorage.download).not.toHaveBeenCalled();
  });

  it("rejects a render with a non-admitted codec before upload", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository();
    const objectStorage = storage();
    const invalidRenderer: VerticalRenderer = {
      ...renderer,
      render: vi.fn(async (_input, output) => {
        await writeFile(output, "invalid-output");
        return {
          durationMs: 30_000,
          width: 1080,
          height: 1920,
          videoCodec: "hevc",
          audioCodec: "aac",
          ffmpegVersion: "ffmpeg-test",
        };
      }),
    };
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      invalidRenderer,
      scratch,
      60_000,
    );

    await expect(process.execute(claim.jobId)).rejects.toThrow(
      "VERTICAL_OUTPUT_INVALID",
    );
    expect(objectStorage.upload).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalled();
  });

  it("aborts an active render and releases its lease during shutdown", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository();
    const objectStorage = storage();
    const hangingRenderer: VerticalRenderer = {
      ...renderer,
      render: vi.fn(
        async (_input, _output, signal) =>
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      ),
    };
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      hangingRenderer,
      scratch,
      60_000,
    );

    const processing = process.execute(claim.jobId);
    await vi.waitFor(() =>
      expect(hangingRenderer.render).toHaveBeenCalledOnce(),
    );
    process.abortAll();

    await expect(processing).resolves.toBe(false);
    expect(repo.release).toHaveBeenCalledWith(claim);
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("releases a claim returned after shutdown without starting I/O", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const deferred = Promise.withResolvers<typeof claim>();
    const repo = repository({ claim: vi.fn(() => deferred.promise) });
    const objectStorage = storage();
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      renderer,
      scratch,
      60_000,
    );

    const processing = process.execute(claim.jobId);
    await vi.waitFor(() => expect(repo.claim).toHaveBeenCalledOnce());
    process.abortAll();
    deferred.resolve(claim);

    await expect(processing).resolves.toBe(false);
    expect(repo.release).toHaveBeenCalledWith(claim);
    expect(objectStorage.download).not.toHaveBeenCalled();
  });

  it("bounds a renderer that never settles on its own", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cf-vertical-test-"));
    directories.push(scratch);
    const repo = repository();
    const objectStorage = storage();
    const hangingRenderer: VerticalRenderer = {
      ...renderer,
      render: vi.fn(
        async (_input, _output, signal) =>
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      ),
    };
    const process = new ProcessVerticalRender(
      repo,
      objectStorage,
      hangingRenderer,
      scratch,
      60_000,
      10,
    );

    await expect(process.execute(claim.jobId)).rejects.toThrow(
      "VERTICAL_RENDER_TIMEOUT",
    );
    expect(repo.complete).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(
      claim,
      "VERTICAL_RENDER_TIMEOUT",
      expect.any(String),
    );
  });
});
