import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CapacityReservation,
  FilesystemCapacityLedger,
  FilesystemTarget,
  SourceCache,
  SourceCacheHandle,
  SourceCacheIdentity,
  SourceCacheTelemetry,
  SourceProbeResult,
} from "../application/ports.js";
import { ControlledMediaError } from "../domain/media-job.js";
import { verifyScratchCapability } from "./scratch-capability.js";

interface CacheEntry {
  path: string;
  sizeBytes: bigint;
  mtimeMs: number;
  refCount: number;
  lastAccessMs: number;
  probe?: SourceProbeResult;
  probeFlight?: ProbeFlight;
}

interface InflightFill {
  promise: Promise<CacheEntry>;
  controller: AbortController;
  waiters: number;
  sizeBytes: bigint;
  settled: boolean;
}

interface ProbeFlight {
  promise: Promise<SourceProbeResult>;
  controller: AbortController;
  waiters: number;
}

export interface LocalSourceCacheOptions {
  directory: string;
  maxBytes: bigint;
  ttlMs: number;
  capacityLedger: FilesystemCapacityLedger;
  cacheTarget: FilesystemTarget;
  outputTarget: FilesystemTarget;
}

export class LocalSourceCache implements SourceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightFill>();
  private initialized: Promise<void> | undefined;
  private currentBytes = 0n;
  private fillReservedBytes = 0n;
  private evictionCount = 0;
  private evictedBytes = 0n;
  private lock: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: LocalSourceCacheOptions) {
    if (options.cacheTarget.id === options.outputTarget.id)
      throw new Error("SOURCE_CACHE_CAPACITY_TARGET_INVALID");
  }

  async acquire(input: {
    identity: SourceCacheIdentity;
    outputReservationBytes: bigint;
    safetyBytes: bigint;
    signal: AbortSignal;
    fill(destination: string, signal: AbortSignal): Promise<void>;
    onTelemetry?(event: SourceCacheTelemetry): void;
  }): Promise<SourceCacheHandle> {
    const startedAt = performance.now();
    const key = cacheKey(input.identity);
    let entry: CacheEntry | undefined;
    let fill: InflightFill | undefined;
    let reservation: CapacityReservation | undefined;
    let outcome: SourceCacheHandle["outcome"] = "hit";
    const evictionCountBefore = this.evictionCount;
    const evictedBytesBefore = this.evictedBytes;

    try {
      if (input.signal.aborted) throw input.signal.reason;
      await this.ensureInitialized();
      if (this.closed) throw new Error("SOURCE_CACHE_CLOSED");
      await this.exclusive(async () => {
        if (this.closed) throw new Error("SOURCE_CACHE_CLOSED");
        if (input.signal.aborted) throw input.signal.reason;
        entry = await this.validEntry(key, input.identity);
        if (entry) {
          reservation = await this.reserve(input.outputReservationBytes);
          if (this.closed) throw new Error("SOURCE_CACHE_CLOSED");
          if (input.signal.aborted) throw input.signal.reason;
          entry.refCount += 1;
          entry.lastAccessMs = Date.now();
          return;
        }

        fill = this.inflight.get(key);
        if (fill) {
          reservation = await this.reserve(input.outputReservationBytes);
          if (this.closed) throw new Error("SOURCE_CACHE_CLOSED");
          if (input.signal.aborted) throw input.signal.reason;
          fill.waiters += 1;
          outcome = "single_flight_wait";
          return;
        }

        await this.evictForBudget(input.identity.sizeBytes);
        reservation = await this.reserve(
          input.outputReservationBytes,
          input.identity.sizeBytes,
        );
        if (this.closed) throw new Error("SOURCE_CACHE_CLOSED");
        if (input.signal.aborted) throw input.signal.reason;
        const controller = new AbortController();
        const created: InflightFill = {
          controller,
          waiters: 1,
          sizeBytes: input.identity.sizeBytes,
          settled: false,
          promise: Promise.resolve(undefined as unknown as CacheEntry),
        };
        this.fillReservedBytes += input.identity.sizeBytes;
        created.promise = this.fillEntry(
          key,
          input.identity,
          controller.signal,
          input.fill,
          reservation,
          input.onTelemetry,
        );
        void created.promise.catch(() => undefined);
        this.inflight.set(key, created);
        fill = created;
        outcome = "fill";
      });
    } catch (error) {
      reservation?.release();
      this.emit(input.onTelemetry, {
        phase: "cache_lookup",
        durationMs: elapsed(startedAt),
        outcome: telemetryOutcome(error, input.signal),
        cacheOutcome: "miss",
        ...this.cacheStats(evictionCountBefore, evictedBytesBefore),
      });
      throw error;
    }

    const resolvedOutcome = outcome as SourceCacheHandle["outcome"];
    this.emit(input.onTelemetry, {
      phase: "cache_lookup",
      durationMs: elapsed(startedAt),
      outcome: "success",
      cacheOutcome:
        resolvedOutcome === "fill"
          ? "miss"
          : resolvedOutcome === "hit"
            ? "hit"
            : "single_flight_wait",
      ...this.cacheStats(evictionCountBefore, evictedBytesBefore),
    });

    if (entry) {
      return this.handle(entry, resolvedOutcome, reservation!);
    }

    const waitStartedAt = performance.now();
    try {
      entry = await waitWithAbort(fill!.promise, input.signal);
      await this.exclusive(async () => {
        if (input.signal.aborted) throw input.signal.reason;
        entry!.refCount += 1;
        entry!.lastAccessMs = Date.now();
      });
      if (resolvedOutcome === "single_flight_wait") {
        this.emit(input.onTelemetry, {
          phase: "cache_wait",
          durationMs: elapsed(waitStartedAt),
          outcome: "success",
          cacheOutcome: "single_flight_wait",
          currentCacheBytes: this.currentBytes.toString(),
        });
      }
    } catch (error) {
      // A fill owns its cache-domain reservation until its writer has settled.
      // Cancelling one consumer releases only that consumer's output domain.
      reservation!.releaseTarget(this.options.outputTarget);
      if (resolvedOutcome === "single_flight_wait") {
        this.emit(input.onTelemetry, {
          phase: "cache_wait",
          durationMs: elapsed(waitStartedAt),
          outcome: telemetryOutcome(error, input.signal),
          cacheOutcome: "single_flight_wait",
          currentCacheBytes: this.currentBytes.toString(),
        });
      }
      throw error;
    } finally {
      let abandonedFill: Promise<CacheEntry> | undefined;
      await this.exclusive(async () => {
        const active = this.inflight.get(key);
        if (active && active === fill) {
          active.waiters -= 1;
          if (active.waiters === 0) {
            if (active.settled) this.inflight.delete(key);
            else {
              active.controller.abort(input.signal.reason);
              abandonedFill = active.promise;
            }
          }
        }
      });
      if (abandonedFill) await Promise.allSettled([abandonedFill]);
    }

    return this.handle(entry, resolvedOutcome, reservation!);
  }

  async close(): Promise<void> {
    this.closed = true;
    let fills: InflightFill[] = [];
    await this.exclusive(async () => {
      fills = [...this.inflight.values()];
      for (const fill of fills) fill.controller.abort();
    });
    await Promise.allSettled(fills.map((fill) => fill.promise));
    await this.ensureInitialized();
    await this.removeDirectoryContents();
    this.entries.clear();
    this.currentBytes = 0n;
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      await verifyScratchCapability(this.options.directory);
      // Cache metadata is intentionally process-local. A restart is a safe miss.
      await this.removeDirectoryContents();
    })();
    await this.initialized;
  }

  private async removeDirectoryContents(): Promise<void> {
    const names = await readdir(this.options.directory).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    await Promise.all(
      names.map((name) =>
        rm(join(this.options.directory, name), {
          recursive: true,
          force: true,
        }),
      ),
    );
  }

  private async fillEntry(
    key: string,
    identity: SourceCacheIdentity,
    signal: AbortSignal,
    fill: (destination: string, signal: AbortSignal) => Promise<void>,
    reservation: CapacityReservation,
    onTelemetry?: (event: SourceCacheTelemetry) => void,
  ): Promise<CacheEntry> {
    const readyPath = join(this.options.directory, `${key}.mp4`);
    const temporaryPath = join(
      this.options.directory,
      `${key}.${randomUUID()}.partial`,
    );
    try {
      await writeFile(temporaryPath, "", { mode: 0o600 });
      if (signal.aborted) throw signal.reason;
      const downloadStartedAt = performance.now();
      let downloadedBytes: bigint | undefined;
      try {
        await fill(temporaryPath, signal);
        if (signal.aborted) throw signal.reason;
        downloadedBytes = BigInt((await stat(temporaryPath)).size);
        this.emit(onTelemetry, {
          phase: "source_download",
          durationMs: elapsed(downloadStartedAt),
          outcome: "success",
          bytes: downloadedBytes.toString(),
          cacheOutcome: "miss",
          currentCacheBytes: this.currentBytes.toString(),
        });
      } catch (error) {
        this.emit(onTelemetry, {
          phase: "source_download",
          durationMs: elapsed(downloadStartedAt),
          outcome: telemetryOutcome(error, signal),
          ...(downloadedBytes === undefined
            ? {}
            : { bytes: downloadedBytes.toString() }),
          cacheOutcome: "miss",
          currentCacheBytes: this.currentBytes.toString(),
        });
        throw error;
      }

      const integrityStartedAt = performance.now();
      try {
        if (downloadedBytes !== identity.sizeBytes) throw cacheIntegrityError();
        if (
          (await hashFile(temporaryPath, signal)) !==
          identity.sha256.toLowerCase()
        ) {
          throw cacheIntegrityError();
        }
        if (signal.aborted) throw signal.reason;
      } catch (error) {
        this.emit(onTelemetry, {
          phase: "source_integrity_hash",
          durationMs: elapsed(integrityStartedAt),
          outcome: telemetryOutcome(error, signal),
          bytes: downloadedBytes.toString(),
          cacheOutcome: "miss",
          currentCacheBytes: this.currentBytes.toString(),
        });
        throw error;
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, readyPath);
      const ready = await stat(readyPath);
      const entry: CacheEntry = {
        path: readyPath,
        sizeBytes: identity.sizeBytes,
        mtimeMs: ready.mtimeMs,
        refCount: 0,
        lastAccessMs: Date.now(),
      };
      await this.exclusive(async () => {
        this.entries.set(key, entry);
        this.currentBytes += identity.sizeBytes;
      });
      this.emit(onTelemetry, {
        phase: "source_integrity_hash",
        durationMs: elapsed(integrityStartedAt),
        outcome: "success",
        bytes: downloadedBytes.toString(),
        cacheOutcome: "miss",
        currentCacheBytes: this.currentBytes.toString(),
      });
      return entry;
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } finally {
        // Actual physical leftovers remain visible to statfs; no I/O survives.
        reservation.releaseTarget(this.options.cacheTarget);
        await this.exclusive(async () => {
          const active = this.inflight.get(key);
          if (active) {
            this.fillReservedBytes -= active.sizeBytes;
            active.settled = true;
            if (active.waiters === 0) this.inflight.delete(key);
          }
        });
      }
    }
  }

  private async validEntry(
    key: string,
    identity: SourceCacheIdentity,
  ): Promise<CacheEntry | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (
      entry.refCount === 0 &&
      !this.inflight.has(key) &&
      Date.now() - entry.lastAccessMs >= this.options.ttlMs
    ) {
      await this.invalidate(key, entry);
      return undefined;
    }
    try {
      const file = await stat(entry.path);
      if (BigInt(file.size) !== identity.sizeBytes) {
        await this.invalidate(key, entry);
        return undefined;
      }
      if (file.mtimeMs !== entry.mtimeMs) {
        if ((await hashFile(entry.path)) !== identity.sha256.toLowerCase()) {
          await this.invalidate(key, entry);
          return undefined;
        }
        entry.mtimeMs = file.mtimeMs;
      }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.invalidate(key, entry);
        return undefined;
      }
      throw error;
    }
  }

  private async invalidate(key: string, entry: CacheEntry): Promise<void> {
    if (entry.refCount > 0) {
      throw new ControlledMediaError(
        "SOURCE_CACHE_CORRUPT_IN_USE",
        "Локальная копия исходника повреждена во время использования.",
        true,
      );
    }
    await rm(entry.path, { force: true });
    if (this.entries.delete(key)) {
      this.currentBytes -= entry.sizeBytes;
      this.evictionCount += 1;
      this.evictedBytes += entry.sizeBytes;
    }
  }

  private async evictForBudget(requiredBytes: bigint): Promise<void> {
    if (requiredBytes > this.options.maxBytes) throw cacheAdmissionError();
    const now = Date.now();
    const candidates = [...this.entries.entries()]
      .filter(([key, entry]) => entry.refCount === 0 && !this.inflight.has(key))
      .sort(([, left], [, right]) => {
        const leftExpired = now - left.lastAccessMs >= this.options.ttlMs;
        const rightExpired = now - right.lastAccessMs >= this.options.ttlMs;
        if (leftExpired !== rightExpired) return leftExpired ? -1 : 1;
        return left.lastAccessMs - right.lastAccessMs;
      });
    for (const [key, entry] of candidates) {
      if (
        this.currentBytes + this.fillReservedBytes + requiredBytes <=
        this.options.maxBytes
      )
        break;
      await rm(entry.path, { force: true });
      this.entries.delete(key);
      this.currentBytes -= entry.sizeBytes;
      this.evictionCount += 1;
      this.evictedBytes += entry.sizeBytes;
    }
    if (
      this.currentBytes + this.fillReservedBytes + requiredBytes >
      this.options.maxBytes
    ) {
      throw cacheAdmissionError();
    }
  }

  private async reserve(
    outputBytes: bigint,
    fillBytes?: bigint,
  ): Promise<CapacityReservation> {
    const reservation = await this.options.capacityLedger.tryReserve([
      { target: this.options.outputTarget, futureBytes: outputBytes },
      ...(fillBytes === undefined
        ? []
        : [{ target: this.options.cacheTarget, futureBytes: fillBytes }]),
    ]);
    if (!reservation) throw cacheAdmissionError();
    return reservation;
  }

  private handle(
    entry: CacheEntry,
    outcome: SourceCacheHandle["outcome"],
    reservation: CapacityReservation,
  ): SourceCacheHandle {
    let released = false;
    return {
      path: entry.path,
      outcome,
      probe: (load, signal) => this.probeEntry(entry, load, signal),
      release: async () => {
        if (released) return;
        released = true;
        await this.exclusive(async () => {
          entry.refCount = Math.max(0, entry.refCount - 1);
          entry.lastAccessMs = Date.now();
          reservation.releaseTarget(this.options.outputTarget);
        });
      },
    };
  }

  private async probeEntry(
    entry: CacheEntry,
    load: (signal: AbortSignal) => Promise<SourceProbeResult>,
    signal: AbortSignal,
  ): Promise<{ result: SourceProbeResult; hit: boolean }> {
    if (signal.aborted) throw signal.reason;
    let cached: SourceProbeResult | undefined;
    let flight: ProbeFlight | undefined;

    await this.exclusive(async () => {
      cached = entry.probe;
      if (cached) return;
      flight = entry.probeFlight;
      if (flight) {
        flight.waiters += 1;
        return;
      }
      const controller = new AbortController();
      const created: ProbeFlight = {
        controller,
        waiters: 1,
        promise: Promise.resolve(undefined as unknown as SourceProbeResult),
      };
      created.promise = this.loadProbe(entry, created, load);
      void created.promise.catch(() => undefined);
      entry.probeFlight = created;
      flight = created;
    });

    if (cached) return { result: cached, hit: true };

    try {
      return {
        result: await waitWithAbort(flight!.promise, signal),
        hit: false,
      };
    } finally {
      let abandonedProbe: Promise<SourceProbeResult> | undefined;
      await this.exclusive(async () => {
        const active = entry.probeFlight;
        if (active && active === flight) {
          active.waiters -= 1;
          if (active.waiters === 0) {
            active.controller.abort(signal.reason);
            abandonedProbe = active.promise;
          }
        }
      });
      if (abandonedProbe) await Promise.allSettled([abandonedProbe]);
    }
  }

  private async loadProbe(
    entry: CacheEntry,
    flight: ProbeFlight,
    load: (signal: AbortSignal) => Promise<SourceProbeResult>,
  ): Promise<SourceProbeResult> {
    try {
      if (flight.controller.signal.aborted)
        throw flight.controller.signal.reason;
      const result = await load(flight.controller.signal);
      if (flight.controller.signal.aborted)
        throw flight.controller.signal.reason;
      entry.probe = result;
      return result;
    } finally {
      await this.exclusive(async () => {
        if (entry.probeFlight === flight) entry.probeFlight = undefined;
      });
    }
  }

  private cacheStats(
    evictionCountBefore: number,
    evictedBytesBefore: bigint,
  ): Pick<
    SourceCacheTelemetry,
    "evictionCount" | "evictedBytes" | "currentCacheBytes"
  > {
    return {
      evictionCount: this.evictionCount - evictionCountBefore,
      evictedBytes: (this.evictedBytes - evictedBytesBefore).toString(),
      currentCacheBytes: this.currentBytes.toString(),
    };
  }

  private emit(
    telemetry: ((event: SourceCacheTelemetry) => void) | undefined,
    event: SourceCacheTelemetry,
  ): void {
    try {
      telemetry?.(event);
    } catch {
      // Observability must not change cache behavior.
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let unlock!: () => void;
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }
}

function cacheKey(identity: SourceCacheIdentity): string {
  return createHash("sha256")
    .update(`${identity.sourceId}:${identity.sourceVersion}:${identity.sha256}`)
    .digest("hex");
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw signal.reason;
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cacheIntegrityError(): ControlledMediaError {
  return new ControlledMediaError(
    "SOURCE_CACHE_INTEGRITY_FAILED",
    "Загруженный исходник не прошёл проверку размера и контрольной суммы.",
    true,
  );
}

function cacheAdmissionError(): ControlledMediaError {
  return new ControlledMediaError(
    "SOURCE_CACHE_ADMISSION_DENIED",
    "Недостаточно временного дискового пространства для кэша и результата.",
    true,
  );
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function telemetryOutcome(
  error: unknown,
  signal: AbortSignal,
): SourceCacheTelemetry["outcome"] {
  if (
    signal.aborted ||
    (error instanceof ControlledMediaError &&
      (error.code === "JOB_LEASE_LOST" ||
        error.code === "MEDIA_JOB_TIMEOUT")) ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "aborted";
  }
  return "failure";
}
