import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessTwitchVodIngest } from "../src/application/process-twitch-vod-ingest.js";

const directories: string[] = [];
const intentId = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProcessTwitchVodIngest", () => {
  it("downloads, validates, hashes, uploads and finalizes one leased VOD", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 20]),
      Buffer.from("ftypisom"),
      Buffer.alloc(32, 7),
    ]);
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "candidate",
        providerVideoId: "123",
        projectName: "Stream",
        attemptCount: 1,
        leaseOwner: "worker",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      checkpoint: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(async (_id: string, offset: bigint) => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(Number(offset)));
            controller.close();
          },
        }),
        contentType: "video/mp4" as const,
        totalSizeBytes: BigInt(bytes.length),
        offset,
      })),
    };
    const storage = {
      upload: vi.fn(async (input: { filePath: string }) => {
        expect(await readFile(input.filePath)).toEqual(bytes);
        return { etag: "etag" };
      }),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      storage as never,
      scratch,
      1_000n,
      60_000,
    );

    await expect(processor.execute("worker")).resolves.toBe(true);
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadMode: "MULTIPART" }),
    );
  });

  it("rejects non-MP4 media before object storage", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const bytes = Buffer.from("not an mp4 file");
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 3,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      checkpoint: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: "video/mp4" as const,
        totalSizeBytes: BigInt(bytes.length),
        offset: 0n,
      })),
    };
    const storage = { upload: vi.fn() };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      storage as never,
      scratch,
      1_000n,
      60_000,
    );

    await processor.execute("w");
    expect(storage.upload).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(
      intentId,
      "w",
      "TWITCH_VOD_MP4_INVALID",
      expect.any(String),
      false,
    );
  });

  it("cancels an opened response before rejecting an oversized VOD", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const cancel = vi.fn();
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 1,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      checkpoint: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel,
        }),
        contentType: "video/mp4" as const,
        totalSizeBytes: 1_001n,
        offset: 0n,
      })),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      60_000,
    );

    await expect(processor.execute("w")).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(repository.checkpoint).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(
      intentId,
      "w",
      "TWITCH_VOD_TOO_LARGE",
      expect.any(String),
      false,
    );
  });

  it("stops quietly when a fenced checkpoint reports lease loss", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const cancel = vi.fn();
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 1,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      checkpoint: vi.fn(async () => {
        throw new Error("TWITCH_VOD_INGEST_LEASE_LOST");
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({ cancel }),
        contentType: "video/mp4" as const,
        totalSizeBytes: 20n,
        offset: 0n,
      })),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      60_000,
    );

    await expect(processor.execute("w")).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(repository.release).not.toHaveBeenCalled();
  });

  it("resumes after a crash that left a complete verified-size scratch file", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 20]),
      Buffer.from("ftypisom"),
      Buffer.alloc(8),
    ]);
    const directory = join(scratch, "twitch-ingest");
    await mkdir(directory);
    await writeFile(join(directory, `${intentId}.part`), bytes);
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 2,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: BigInt(bytes.length),
      })),
      checkpoint: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = { open: vi.fn() };
    const storage = { upload: vi.fn(async () => ({})) };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      storage as never,
      scratch,
      1_000n,
      60_000,
    );

    await processor.execute("w");
    expect(media.open).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it("aborts a stalled transfer when its lease heartbeat cannot be retained", async () => {
    vi.useFakeTimers();
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 1,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      heartbeat: vi.fn().mockRejectedValue(new Error("database offline")),
      release: vi.fn().mockResolvedValue(true),
      checkpoint: vi.fn(),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(
        async (_id: string, _offset: bigint, signal: AbortSignal) => ({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
          contentType: "video/mp4" as const,
          totalSizeBytes: 100n,
          offset: 0n,
        }),
      ),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      3_000,
    );

    const processing = processor.execute("w");
    await vi.waitFor(() => expect(repository.checkpoint).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(processing).resolves.toBe(false);
    expect(repository.release).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("aborts active transfer without recording failure during graceful shutdown", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 1,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      checkpoint: vi.fn(),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(
        async (_id: string, _offset: bigint, signal: AbortSignal) => ({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
          contentType: "video/mp4" as const,
          totalSizeBytes: 100n,
          offset: 0n,
        }),
      ),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      60_000,
    );

    const processing = processor.execute("w");
    await vi.waitFor(() => expect(repository.checkpoint).toHaveBeenCalled());
    processor.abortAll();

    await expect(processing).resolves.toBe(false);
    expect(repository.release).toHaveBeenCalledWith(intentId, "w");
    expect(repository.fail).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("does not start transfer when shutdown arrives during claim", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    let resolveClaim:
      | ((claim: {
          id: string;
          candidateId: string;
          providerVideoId: string;
          projectName: string;
          attemptCount: number;
          leaseOwner: string;
          downloadedBytes: bigint;
          totalBytes: null;
        }) => void)
      | undefined;
    const repository = {
      claimNext: vi.fn(
        () =>
          new Promise<{
            id: string;
            candidateId: string;
            providerVideoId: string;
            projectName: string;
            attemptCount: number;
            leaseOwner: string;
            downloadedBytes: bigint;
            totalBytes: null;
          }>((resolve) => {
            resolveClaim = resolve;
          }),
      ),
      heartbeat: vi.fn(),
      release: vi.fn().mockResolvedValue(true),
      checkpoint: vi.fn(),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = { open: vi.fn() };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      60_000,
    );

    const processing = processor.execute("w");
    await vi.waitFor(() => expect(repository.claimNext).toHaveBeenCalled());
    processor.abortAll();
    resolveClaim?.({
      id: intentId,
      candidateId: "c",
      providerVideoId: "1",
      projectName: "x",
      attemptCount: 1,
      leaseOwner: "w",
      downloadedBytes: 0n,
      totalBytes: null,
    });

    await expect(processing).resolves.toBe(false);
    expect(repository.release).toHaveBeenCalledWith(intentId, "w");
    expect(media.open).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("bounds a stalled transfer even while its lease remains healthy", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "twitch-ingest-"));
    directories.push(scratch);
    const repository = {
      claimNext: vi.fn(async () => ({
        id: intentId,
        candidateId: "c",
        providerVideoId: "1",
        projectName: "x",
        attemptCount: 1,
        leaseOwner: "w",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      checkpoint: vi.fn(),
      beginUpload: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const media = {
      open: vi.fn(
        async (_id: string, _offset: bigint, signal: AbortSignal) => ({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
          contentType: "video/mp4" as const,
          totalSizeBytes: 100n,
          offset: 0n,
        }),
      ),
    };
    const processor = new ProcessTwitchVodIngest(
      repository,
      media,
      { upload: vi.fn() } as never,
      scratch,
      1_000n,
      60_000,
      10,
    );

    await expect(processor.execute("w")).resolves.toBe(true);
    expect(repository.fail).toHaveBeenCalledWith(
      intentId,
      "w",
      expect.stringContaining("TWITCH_VOD_INGEST_TIMEOUT"),
      expect.any(String),
      true,
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });
});
