import { lstat, statfs } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

import type {
  CapacityRequest,
  CapacityReservation,
  FilesystemCapacityLedger,
  FilesystemTarget,
} from "../application/ports.js";
import {
  ScratchCapabilityError,
  usableScratchFilesystem,
} from "./scratch-capability.js";

export interface FilesystemCapacityReading {
  device: bigint;
  availableBytes: bigint;
}

export type FilesystemCapacityReader = (
  directory: string,
) => Promise<FilesystemCapacityReading>;

interface RegisteredRoot {
  directory: string;
  target: FilesystemTarget;
}

function assertRootPath(directory: string): void {
  if (
    directory !== resolve(directory) ||
    /[\0\r\n]/.test(directory) ||
    directory
      .split(sep)
      .some((part) =>
        /^(?:se[aá]nova(?:-new)?|dockerserver)$/iu.test(part.normalize("NFC")),
      )
  )
    throw new ScratchCapabilityError();
}

async function readPrivateFilesystem(
  directory: string,
): Promise<FilesystemCapacityReading> {
  assertRootPath(directory);
  let parent = parse(directory).root;
  for (const segment of directory.split(sep).filter(Boolean)) {
    parent = join(parent, segment);
    const attributes = await lstat(parent);
    if (attributes.isSymbolicLink() || !attributes.isDirectory())
      throw new ScratchCapabilityError();
  }
  const uid = process.geteuid?.();
  const root = await lstat(directory, { bigint: true });
  if (
    uid === undefined ||
    uid === 0 ||
    root.uid !== BigInt(uid) ||
    (root.mode & 0o7777n) !== 0o700n
  )
    throw new ScratchCapabilityError();
  const disk = await statfs(directory, { bigint: true });
  if (!usableScratchFilesystem(disk)) throw new ScratchCapabilityError();
  return { device: root.dev, availableBytes: disk.bavail * disk.bsize };
}

/** One instance per admitted process. All registered roots are revalidated
 * inside the admission mutex. Device sharing is determined by st_dev, not
 * directory or volume names. Persistent/durable claims remain separate. */
export class LocalFilesystemCapacityLedger implements FilesystemCapacityLedger {
  private readonly roots = new Map<symbol, RegisteredRoot>();
  private readonly safetyByDevice = new Map<bigint, bigint>();
  private readonly localByDevice = new Map<bigint, bigint>();
  private recoveredByDevice = new Map<bigint, bigint>();
  private readonly active = new Set<symbol>();
  private mutation = 0;
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly read: FilesystemCapacityReader = readPrivateFilesystem,
  ) {}

  async registerRoot(
    directory: string,
    safetyBytes: bigint,
  ): Promise<FilesystemTarget> {
    assertRootPath(directory);
    if (typeof safetyBytes !== "bigint" || safetyBytes < 0n)
      throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
    return this.exclusive(async () => {
      let reading: FilesystemCapacityReading;
      try {
        reading = await this.read(directory);
        this.assertReading(reading);
      } catch {
        throw new ScratchCapabilityError();
      }
      const target = Object.freeze({
        id: Symbol("filesystem-target"),
        device: reading.device,
      });
      this.roots.set(target.id, { directory, target });
      const previous = this.safetyByDevice.get(target.device) ?? 0n;
      this.safetyByDevice.set(
        target.device,
        safetyBytes > previous ? safetyBytes : previous,
      );
      this.mutation += 1;
      return target;
    });
  }

  async tryReserve(
    requests: readonly CapacityRequest[],
  ): Promise<CapacityReservation | null> {
    if (requests.length === 0)
      throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
    const immutable = this.copyRequests(requests);
    const requested = this.aggregate(immutable);
    return this.exclusive(async () => {
      const sampledMutation = this.mutation;
      let available: Map<bigint, bigint>;
      try {
        available = await this.readDomains();
      } catch {
        return null;
      }
      // A writer can settle while statfs is in flight. Its retained physical
      // bytes must not be paired with a pre-write sample and a post-release
      // ledger. Refuse this admission; the existing caller retry path resamples.
      if (sampledMutation !== this.mutation) return null;
      for (const [device, bytes] of requested) {
        const required =
          bytes +
          (this.localByDevice.get(device) ?? 0n) +
          (this.recoveredByDevice.get(device) ?? 0n) +
          (this.safetyByDevice.get(device) ?? 0n);
        if ((available.get(device) ?? 0n) < required) return null;
      }
      // No await between the all-device decision and committing every hold.
      for (const [device, bytes] of requested)
        this.localByDevice.set(
          device,
          (this.localByDevice.get(device) ?? 0n) + bytes,
        );
      this.mutation += 1;
      return this.receipt(immutable);
    });
  }

  replaceRecoveredReservation(
    owner: "media-export-recovery",
    requests: readonly CapacityRequest[],
  ): void {
    if (owner !== "media-export-recovery")
      throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
    // Build/validate completely before atomic replacement, never clear first.
    const replacement = this.aggregate(this.copyRequests(requests));
    this.recoveredByDevice = replacement;
    this.mutation += 1;
  }

  assertNoLocalReservations(): void {
    if (
      this.active.size !== 0 ||
      [...this.localByDevice.values()].some((bytes) => bytes !== 0n)
    )
      throw new Error("FILESYSTEM_CAPACITY_RESERVATION_LEAK");
  }

  private receipt(requests: readonly CapacityRequest[]): CapacityReservation {
    const id = Symbol("capacity-receipt");
    const remaining = new Map<symbol, CapacityRequest>();
    const belonging = new Set(requests.map((request) => request.target.id));
    for (const request of requests) {
      const previous = remaining.get(request.target.id);
      remaining.set(request.target.id, {
        target: request.target,
        futureBytes: request.futureBytes + (previous?.futureBytes ?? 0n),
      });
    }
    this.active.add(id);
    const releaseTarget = (target: FilesystemTarget): void => {
      this.requireTarget(target);
      if (!belonging.has(target.id))
        throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
      const hold = remaining.get(target.id);
      if (!hold) return;
      const after =
        (this.localByDevice.get(target.device) ?? 0n) - hold.futureBytes;
      if (after < 0n)
        throw new Error("FILESYSTEM_CAPACITY_RESERVATION_INVALID");
      this.localByDevice.set(target.device, after);
      remaining.delete(target.id);
      this.mutation += 1;
      if (remaining.size === 0) this.active.delete(id);
    };
    return Object.freeze({
      requests,
      releaseTarget,
      release: (): void => {
        for (const hold of remaining.values()) releaseTarget(hold.target);
      },
      availableForExistingFrameClaim: (
        target: FilesystemTarget,
      ): Promise<bigint> =>
        this.exclusive(async () => {
          this.requireTarget(target);
          if (!remaining.has(target.id))
            throw new Error("FILESYSTEM_CAPACITY_RESERVATION_INVALID");
          const sampledMutation = this.mutation;
          let available: Map<bigint, bigint>;
          try {
            available = await this.readDomains();
          } catch {
            return 0n;
          }
          if (!remaining.has(target.id))
            throw new Error("FILESYSTEM_CAPACITY_RESERVATION_INVALID");
          if (sampledMutation !== this.mutation) return 0n;
          const own =
            this.aggregate([...remaining.values()]).get(target.device) ?? 0n;
          const other = (this.localByDevice.get(target.device) ?? 0n) - own;
          const value =
            (available.get(target.device) ?? 0n) -
            other -
            (this.recoveredByDevice.get(target.device) ?? 0n);
          // Existing PG requiredScratchBytes already includes its safety reserve.
          return value > 0n ? value : 0n;
        }),
    });
  }

  private copyRequests(
    requests: readonly CapacityRequest[],
  ): readonly CapacityRequest[] {
    return Object.freeze(
      requests.map((request) => {
        this.requireTarget(request.target);
        if (typeof request.futureBytes !== "bigint" || request.futureBytes < 0n)
          throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
        return Object.freeze({
          target: request.target,
          futureBytes: request.futureBytes,
        });
      }),
    );
  }

  private requireTarget(target: FilesystemTarget): void {
    const known = this.roots.get(target?.id);
    if (!known || known.target !== target)
      throw new Error("FILESYSTEM_CAPACITY_REQUEST_INVALID");
  }

  private aggregate(requests: readonly CapacityRequest[]): Map<bigint, bigint> {
    const result = new Map<bigint, bigint>();
    for (const { target, futureBytes } of requests)
      result.set(
        target.device,
        (result.get(target.device) ?? 0n) + futureBytes,
      );
    return result;
  }

  private assertReading(reading: FilesystemCapacityReading): void {
    if (
      typeof reading.device !== "bigint" ||
      reading.device < 0n ||
      typeof reading.availableBytes !== "bigint" ||
      reading.availableBytes < 0n
    )
      throw new ScratchCapabilityError();
  }

  private async readDomains(): Promise<Map<bigint, bigint>> {
    const result = new Map<bigint, bigint>();
    for (const { directory, target } of this.roots.values()) {
      const reading = await this.read(directory);
      this.assertReading(reading);
      if (reading.device !== target.device) throw new ScratchCapabilityError();
      const previous = result.get(target.device);
      result.set(
        target.device,
        previous === undefined || reading.availableBytes < previous
          ? reading.availableBytes
          : previous,
      );
    }
    return result;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let unlock!: () => void;
    this.mutex = new Promise<void>((resolveMutex) => {
      unlock = resolveMutex;
    });
    await previous;
    try {
      return await action();
    } finally {
      unlock();
    }
  }
}
