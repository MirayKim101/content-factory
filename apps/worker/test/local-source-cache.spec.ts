import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SourceCacheIdentity,
  SourceCacheTelemetry,
} from "../src/application/ports.js";
import { LocalSourceCache } from "../src/infrastructure/local-source-cache.js";

const directories: string[] = [];

describe("LocalSourceCache", () => {
  it("single-flights five same-source consumers into one verified download", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("immutable-source");
    const identity = sourceIdentity("source-a", bytes);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const fill = vi.fn(async (destination: string) => {
      await gate;
      await writeFile(destination, bytes);
    });

    const acquisitions = Array.from({ length: 5 }, () =>
      cache.acquire({
        identity,
        outputReservationBytes: 1n,
        safetyBytes: 0n,
        signal: new AbortController().signal,
        fill,
      }),
    );
    await vi.waitFor(() => expect(fill).toHaveBeenCalledOnce());
    unblock();
    const handles = await Promise.all(acquisitions);

    expect(fill).toHaveBeenCalledOnce();
    expect(new Set(handles.map((handle) => handle.path))).toHaveLength(1);
    expect(handles.filter((handle) => handle.outcome === "fill")).toHaveLength(
      1,
    );
    expect(
      handles.filter((handle) => handle.outcome === "single_flight_wait"),
    ).toHaveLength(4);
    await Promise.all(handles.map((handle) => handle.release()));
    await cache.close();
  });

  it("reports misses, single-flight waits, hits, and cache byte statistics", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("telemetry-source");
    const identity = sourceIdentity("source-telemetry", bytes);
    const ownerEvents: SourceCacheTelemetry[] = [];
    const waiterEvents: SourceCacheTelemetry[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const fill = async (destination: string) => {
      await gate;
      await writeFile(destination, bytes);
    };
    const owner = acquire(cache, identity, fill, (event) =>
      ownerEvents.push(event),
    );
    const waiter = acquire(cache, identity, fill, (event) =>
      waiterEvents.push(event),
    );
    await vi.waitFor(() =>
      expect(
        waiterEvents.find((event) => event.phase === "cache_lookup"),
      ).toMatchObject({ cacheOutcome: "single_flight_wait" }),
    );
    unblock();
    const [ownerHandle, waiterHandle] = await Promise.all([owner, waiter]);
    await ownerHandle.release();
    await waiterHandle.release();

    const hitEvents: SourceCacheTelemetry[] = [];
    const hit = await acquire(cache, identity, vi.fn(), (event) =>
      hitEvents.push(event),
    );
    expect(ownerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "cache_lookup",
          outcome: "success",
          cacheOutcome: "miss",
        }),
        expect.objectContaining({
          phase: "source_download",
          outcome: "success",
          bytes: bytes.length.toString(),
        }),
        expect.objectContaining({
          phase: "source_integrity_hash",
          outcome: "success",
          currentCacheBytes: bytes.length.toString(),
        }),
      ]),
    );
    expect(waiterEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "cache_wait",
          outcome: "success",
          cacheOutcome: "single_flight_wait",
        }),
      ]),
    );
    expect(hitEvents).toEqual([
      expect.objectContaining({
        phase: "cache_lookup",
        cacheOutcome: "hit",
        currentCacheBytes: bytes.length.toString(),
      }),
    ]);
    await hit.release();
    await cache.close();
  });

  it("reports failed download and integrity phases without sensitive fields", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("telemetry-failure");
    const identity = sourceIdentity("source-telemetry-failure", bytes);
    const downloadEvents: SourceCacheTelemetry[] = [];
    await expect(
      acquire(
        cache,
        identity,
        async () => {
          throw new Error("storage unavailable");
        },
        (event) => downloadEvents.push(event),
      ),
    ).rejects.toThrow("storage unavailable");
    expect(
      downloadEvents.find((event) => event.phase === "source_download"),
    ).toMatchObject({ outcome: "failure" });

    const integrityEvents: SourceCacheTelemetry[] = [];
    await expect(
      acquire(
        cache,
        identity,
        (destination) => writeFile(destination, Buffer.from("wrong")),
        (event) => integrityEvents.push(event),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CACHE_INTEGRITY_FAILED" });
    expect(
      integrityEvents.find((event) => event.phase === "source_integrity_hash"),
    ).toMatchObject({ outcome: "failure", bytes: "5" });
    const serialized = JSON.stringify([...downloadEvents, ...integrityEvents]);
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("leaseToken");
    await cache.close();
  });

  it("reuses one download and one probe across five sequential clips", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("sequential-source");
    const identity = sourceIdentity("source-sequential", bytes);
    const fill = vi.fn((destination: string) => writeFile(destination, bytes));
    const probe = vi.fn(async () => ({ durationMs: 60_000, version: "probe" }));
    const outcomes: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const handle = await acquire(cache, identity, fill);
      outcomes.push(handle.outcome);
      const result = await handle.probe(probe, new AbortController().signal);
      expect(result.result.durationMs).toBe(60_000);
      await handle.release();
    }

    expect(outcomes).toEqual(["fill", "hit", "hit", "hit", "hit"]);
    expect(fill).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    await cache.close();
  });

  it("single-flights concurrent probes and caches only the successful result", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("probe-source");
    const identity = sourceIdentity("source-probe", bytes);
    const firstHandle = await acquire(cache, identity, (destination) =>
      writeFile(destination, bytes),
    );
    const secondHandle = await acquire(cache, identity, vi.fn());
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const probe = vi.fn(async () => {
      await gate;
      return { durationMs: 60_000, version: "probe-shared" };
    });

    const first = firstHandle.probe(probe, new AbortController().signal);
    const second = secondHandle.probe(probe, new AbortController().signal);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    unblock();

    await expect(first).resolves.toMatchObject({ hit: false });
    await expect(second).resolves.toMatchObject({ hit: false });
    const cached = await firstHandle.probe(
      vi.fn(),
      new AbortController().signal,
    );
    expect(cached).toMatchObject({
      hit: true,
      result: { durationMs: 60_000, version: "probe-shared" },
    });
    expect(probe).toHaveBeenCalledOnce();
    await firstHandle.release();
    await secondHandle.release();
    await cache.close();
  });

  it("isolates an aborted probe waiter while the shared probe serves a survivor", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("probe-abort-source");
    const identity = sourceIdentity("source-probe-abort", bytes);
    const firstHandle = await acquire(cache, identity, (destination) =>
      writeFile(destination, bytes),
    );
    const secondHandle = await acquire(cache, identity, vi.fn());
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const sharedProbe = vi.fn(async (signal: AbortSignal) => {
      await gate;
      if (signal.aborted) throw signal.reason;
      return { durationMs: 42_000, version: "probe-survivor" };
    });
    const lostLease = new AbortController();
    const first = firstHandle.probe(sharedProbe, lostLease.signal);
    const firstRejected = expect(first).rejects.toThrow("JOB_LEASE_LOST");
    const survivor = secondHandle.probe(
      sharedProbe,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(sharedProbe).toHaveBeenCalledOnce());
    await Promise.resolve();
    lostLease.abort(new Error("JOB_LEASE_LOST"));
    unblock();

    await firstRejected;
    await expect(survivor).resolves.toMatchObject({
      result: { durationMs: 42_000 },
    });
    expect(sharedProbe).toHaveBeenCalledOnce();
    await firstHandle.release();
    await secondHandle.release();
    await cache.close();
  });

  it("clears a failed probe flight so the next request can retry", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("probe-retry-source");
    const identity = sourceIdentity("source-probe-retry", bytes);
    const handle = await acquire(cache, identity, (destination) =>
      writeFile(destination, bytes),
    );
    const failedProbe = vi.fn(async () => {
      throw new Error("probe failed");
    });

    await expect(
      handle.probe(failedProbe, new AbortController().signal),
    ).rejects.toThrow("probe failed");
    const successfulProbe = vi.fn(async () => ({
      durationMs: 10_000,
      version: "probe-retry",
    }));
    await expect(
      handle.probe(successfulProbe, new AbortController().signal),
    ).resolves.toMatchObject({
      hit: false,
      result: { durationMs: 10_000 },
    });
    expect(failedProbe).toHaveBeenCalledOnce();
    expect(successfulProbe).toHaveBeenCalledOnce();
    await handle.release();
    await cache.close();
  });

  it("treats changed same-size contents as a miss and refills", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("correct-source");
    const identity = sourceIdentity("source-b", bytes);
    const fill = vi.fn((destination: string) => writeFile(destination, bytes));
    const first = await acquire(cache, identity, fill);
    const path = first.path;
    await first.release();

    await chmod(path, 0o600);
    await writeFile(path, Buffer.from("corrupt-source"));
    const changed = new Date(Date.now() + 2_000);
    await utimes(path, changed, changed);
    const second = await acquire(cache, identity, fill);

    expect(second.outcome).toBe("fill");
    expect(fill).toHaveBeenCalledTimes(2);
    expect(await readFile(second.path)).toEqual(bytes);
    await second.release();
    await cache.close();
  });

  it("rejects a bad size or checksum without publishing a ready entry", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("expected");
    const identity = sourceIdentity("source-c", bytes);

    await expect(
      acquire(cache, identity, (destination) =>
        writeFile(destination, Buffer.from("bad")),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CACHE_INTEGRITY_FAILED" });

    const valid = vi.fn((destination: string) => writeFile(destination, bytes));
    const handle = await acquire(cache, identity, valid);
    expect(handle.outcome).toBe("fill");
    expect(valid).toHaveBeenCalledOnce();
    await handle.release();
    await cache.close();
  });

  it("evicts LRU entries but never an entry with an active reference", async () => {
    const { cache } = await createCache(8n);
    const a = sourceIdentity("a", Buffer.from("aaaa"));
    const b = sourceIdentity("b", Buffer.from("bbbb"));
    const c = sourceIdentity("c", Buffer.from("cccc"));
    const fill = (bytes: Buffer) => (destination: string) =>
      writeFile(destination, bytes);

    const heldA = await acquire(cache, a, fill(Buffer.from("aaaa")));
    const releasedB = await acquire(cache, b, fill(Buffer.from("bbbb")));
    await releasedB.release();
    const evictionEvents: SourceCacheTelemetry[] = [];
    const handleC = await acquire(
      cache,
      c,
      fill(Buffer.from("cccc")),
      (event) => evictionEvents.push(event),
    );
    await handleC.release();
    expect(
      evictionEvents.find((event) => event.phase === "cache_lookup"),
    ).toMatchObject({ evictionCount: 1, evictedBytes: "4" });

    const aAgain = await acquire(cache, a, vi.fn(fill(Buffer.from("aaaa"))));
    expect(aAgain.outcome).toBe("hit");
    await aAgain.release();
    await heldA.release();
    await cache.close();
  });

  it("denies admission when the byte budget is entirely in use", async () => {
    const { cache } = await createCache(4n);
    const aBytes = Buffer.from("aaaa");
    const held = await acquire(
      cache,
      sourceIdentity("held", aBytes),
      (destination) => writeFile(destination, aBytes),
    );
    const bBytes = Buffer.from("bbbb");

    await expect(
      acquire(cache, sourceIdentity("blocked", bBytes), (destination) =>
        writeFile(destination, bBytes),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CACHE_ADMISSION_DENIED" });

    await held.release();
    await cache.close();
  });

  it("expires an unused entry after its TTL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-local-cache-ttl-"));
    directories.push(directory);
    const cache = new LocalSourceCache({
      directory,
      maxBytes: 1024n,
      ttlMs: 1,
    });
    const bytes = Buffer.from("ttl-source");
    const identity = sourceIdentity("ttl", bytes);
    const fill = vi.fn((destination: string) => writeFile(destination, bytes));
    const first = await acquire(cache, identity, fill);
    await first.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await acquire(cache, identity, fill);
    expect(second.outcome).toBe("fill");
    expect(fill).toHaveBeenCalledTimes(2);
    await second.release();
    await cache.close();
  });

  it("keeps a single-flight fill alive for remaining consumers after lease loss", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("shared-source");
    const identity = sourceIdentity("source-d", bytes);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const fill = vi.fn(async (destination: string) => {
      await gate;
      await writeFile(destination, bytes);
    });
    const lostLease = new AbortController();
    const first = cache.acquire({
      identity,
      outputReservationBytes: 1n,
      safetyBytes: 0n,
      signal: lostLease.signal,
      fill,
    });
    const second = acquire(cache, identity, fill);
    await vi.waitFor(() => expect(fill).toHaveBeenCalledOnce());
    lostLease.abort(new Error("JOB_LEASE_LOST"));
    unblock();

    await expect(first).rejects.toThrow("JOB_LEASE_LOST");
    const survivor = await second;
    expect(await readFile(survivor.path)).toEqual(bytes);
    expect(fill).toHaveBeenCalledOnce();
    await survivor.release();
    await cache.close();
  });

  it("does not publish a partial cache entry when the only lease is lost", async () => {
    const { cache } = await createCache(1024n);
    const bytes = Buffer.from("aborted-source");
    const identity = sourceIdentity("source-aborted", bytes);
    const lease = new AbortController();
    const first = cache.acquire({
      identity,
      outputReservationBytes: 0n,
      safetyBytes: 0n,
      signal: lease.signal,
      fill: async (_destination, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const rejected = expect(first).rejects.toThrow("JOB_LEASE_LOST");
    lease.abort(new Error("JOB_LEASE_LOST"));
    await rejected;

    const refill = vi.fn((destination: string) =>
      writeFile(destination, bytes),
    );
    const second = await acquire(cache, identity, refill);
    expect(second.outcome).toBe("fill");
    expect(refill).toHaveBeenCalledOnce();
    await second.release();
    await cache.close();
  });

  it("uses 0700/0600 permissions and starts with a safe miss after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-local-cache-restart-"));
    directories.push(directory);
    const bytes = Buffer.from("restart-source");
    const identity = sourceIdentity("source-e", bytes);
    const firstCache = new LocalSourceCache({
      directory,
      maxBytes: 1024n,
      ttlMs: 60_000,
    });
    const first = await acquire(firstCache, identity, (destination) =>
      writeFile(destination, bytes),
    );
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    await first.release();
    await firstCache.close();

    const secondCache = new LocalSourceCache({
      directory,
      maxBytes: 1024n,
      ttlMs: 60_000,
    });
    const refill = vi.fn((destination: string) =>
      writeFile(destination, bytes),
    );
    const second = await acquire(secondCache, identity, refill);
    expect(second.outcome).toBe("fill");
    expect(refill).toHaveBeenCalledOnce();
    await second.release();
    await secondCache.close();
  });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCache(maxBytes: bigint) {
  const directory = await mkdtemp(join(tmpdir(), "cf-local-cache-test-"));
  directories.push(directory);
  return {
    cache: new LocalSourceCache({ directory, maxBytes, ttlMs: 60_000 }),
    directory,
  };
}

function sourceIdentity(sourceId: string, bytes: Buffer): SourceCacheIdentity {
  return {
    sourceId,
    sourceVersion: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: BigInt(bytes.length),
  };
}

function acquire(
  cache: LocalSourceCache,
  identity: SourceCacheIdentity,
  fill: (destination: string, signal: AbortSignal) => Promise<void>,
  onTelemetry?: (event: SourceCacheTelemetry) => void,
) {
  return cache.acquire({
    identity,
    outputReservationBytes: 0n,
    safetyBytes: 0n,
    signal: new AbortController().signal,
    fill,
    onTelemetry,
  });
}
