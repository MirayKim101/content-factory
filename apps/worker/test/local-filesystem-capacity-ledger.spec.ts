import { describe, expect, it, vi } from "vitest";
import type {
  CapacityReservation,
  FilesystemTarget,
} from "../src/application/ports.js";
import {
  LocalFilesystemCapacityLedger,
  type FilesystemCapacityReading,
} from "../src/infrastructure/local-filesystem-capacity-ledger.js";

async function fixture(split = false, available = 1000n) {
  const readings = new Map<string, FilesystemCapacityReading>([
    ["/fixture/cache", { device: 1n, availableBytes: available }],
    [
      "/fixture/scratch",
      { device: split ? 2n : 1n, availableBytes: available },
    ],
  ]);
  const reader = vi.fn(async (directory: string) => ({
    ...readings.get(directory)!,
  }));
  const ledger = new LocalFilesystemCapacityLedger(reader);
  const cache = await ledger.registerRoot("/fixture/cache", 100n);
  const scratch = await ledger.registerRoot("/fixture/scratch", 150n);
  return { ledger, cache, scratch, readings, reader };
}

async function reserve(
  ledger: LocalFilesystemCapacityLedger,
  requests: Array<{ target: FilesystemTarget; futureBytes: bigint }>,
): Promise<CapacityReservation> {
  const receipt = await ledger.tryReserve(requests);
  expect(receipt).not.toBeNull();
  return receipt!;
}

describe("one-process shared filesystem admission", () => {
  it.each(["local-release", "recovered-replace"] as const)(
    "refuses a stale filesystem sample after %s settles retained physical bytes",
    async (mutation) => {
      const { ledger, cache, scratch, reader, readings } = await fixture();
      const fill =
        mutation === "local-release"
          ? await reserve(ledger, [{ target: cache, futureBytes: 400n }])
          : null;
      if (!fill)
        ledger.replaceRecoveredReservation("media-export-recovery", [
          { target: cache, futureBytes: 400n },
        ]);
      let resume!: () => void;
      let sampled!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const captured = new Promise<void>((resolve) => {
        sampled = resolve;
      });
      reader.mockImplementation(async (directory) => {
        const sample = { ...readings.get(directory)! };
        if (directory === "/fixture/scratch") {
          sampled();
          await gate;
        }
        return sample;
      });
      const admission = ledger.tryReserve([
        { target: scratch, futureBytes: 700n },
      ]);
      await captured;
      for (const path of readings.keys())
        readings.set(path, { device: 1n, availableBytes: 600n });
      if (fill) fill.releaseTarget(cache);
      else ledger.replaceRecoveredReservation("media-export-recovery", []);
      resume();
      expect(await admission).toBeNull();
      // No mutation now: a fresh reading still correctly refuses 700 + 150.
      expect(
        await ledger.tryReserve([{ target: scratch, futureBytes: 700n }]),
      ).toBeNull();
      ledger.assertNoLocalReservations();
    },
  );

  it("returns zero PG availability when another fill releases during frame sampling", async () => {
    const { ledger, cache, scratch, reader, readings } = await fixture();
    const fill = await reserve(ledger, [{ target: cache, futureBytes: 400n }]);
    const frame = await reserve(ledger, [
      { target: scratch, futureBytes: 200n },
    ]);
    let resume!: () => void;
    let sampled!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      sampled = resolve;
    });
    reader.mockImplementation(async (directory) => {
      const sample = { ...readings.get(directory)! };
      if (directory === "/fixture/scratch") {
        sampled();
        await gate;
      }
      return sample;
    });
    const availability = frame.availableForExistingFrameClaim(scratch);
    await captured;
    for (const path of readings.keys())
      readings.set(path, { device: 1n, availableBytes: 600n });
    fill.releaseTarget(cache);
    resume();
    expect(await availability).toBe(0n);
    expect(await frame.availableForExistingFrameClaim(scratch)).toBe(600n);
    frame.release();
    ledger.assertNoLocalReservations();
  });
  it("coalesces sibling roots on one device and uses maximum safety once", async () => {
    const { ledger, cache, scratch } = await fixture();
    const receipt = await reserve(ledger, [
      { target: cache, futureBytes: 400n },
      { target: scratch, futureBytes: 450n },
    ]);
    expect(
      await ledger.tryReserve([{ target: cache, futureBytes: 1n }]),
    ).toBeNull();
    receipt.release();
    ledger.assertNoLocalReservations();
  });

  it("does not authorize scratch output using abundant cache-device capacity", async () => {
    const { ledger, cache, scratch, readings } = await fixture(true);
    readings.set("/fixture/cache", { device: 1n, availableBytes: 100_000n });
    readings.set("/fixture/scratch", { device: 2n, availableBytes: 200n });
    expect(
      await ledger.tryReserve([
        { target: cache, futureBytes: 400n },
        { target: scratch, futureBytes: 51n },
      ]),
    ).toBeNull();
    // Failure on the second device committed no first-device hold.
    const receipt = await reserve(ledger, [
      { target: cache, futureBytes: 99_900n },
    ]);
    receipt.release();
    ledger.assertNoLocalReservations();
  });

  it.each([false, true])(
    "releases target ownership independently, split=%s",
    async (split) => {
      const { ledger, cache, scratch } = await fixture(split);
      const receipt = await reserve(ledger, [
        { target: cache, futureBytes: 300n },
        { target: scratch, futureBytes: 400n },
      ]);
      receipt.releaseTarget(cache);
      receipt.releaseTarget(cache);
      expect(() => ledger.assertNoLocalReservations()).toThrow(
        "FILESYSTEM_CAPACITY_RESERVATION_LEAK",
      );
      const next = await reserve(ledger, [
        { target: cache, futureBytes: split ? 900n : 450n },
      ]);
      expect(
        await ledger.tryReserve([{ target: scratch, futureBytes: 451n }]),
      ).toBeNull();
      receipt.releaseTarget(scratch);
      receipt.release();
      next.release();
      next.release();
      ledger.assertNoLocalReservations();
    },
  );

  it("detects zero-byte lifecycle holds and releases them exactly once", async () => {
    const { ledger, scratch } = await fixture();
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: 0n },
    ]);
    expect(() => ledger.assertNoLocalReservations()).toThrow(
      "FILESYSTEM_CAPACITY_RESERVATION_LEAK",
    );
    receipt.releaseTarget(scratch);
    receipt.release();
    ledger.assertNoLocalReservations();
  });

  it("serializes concurrent decisions without partial or overcommitted holds", async () => {
    const { ledger, scratch, reader } = await fixture();
    let activeReads = 0;
    let peakReads = 0;
    reader.mockImplementation(async () => {
      peakReads = Math.max(peakReads, ++activeReads);
      await Promise.resolve();
      --activeReads;
      return { device: 1n, availableBytes: 1000n };
    });
    const receipts = await Promise.all([
      ledger.tryReserve([{ target: scratch, futureBytes: 600n }]),
      ledger.tryReserve([{ target: scratch, futureBytes: 600n }]),
    ]);
    expect(receipts.filter(Boolean)).toHaveLength(1);
    expect(peakReads).toBe(1);
    for (const receipt of receipts) receipt?.release();
    ledger.assertNoLocalReservations();
  });

  it("rejects device drift and unavailable readings without leaving a token", async () => {
    const { ledger, scratch, readings, reader } = await fixture();
    readings.set("/fixture/cache", { device: 99n, availableBytes: 1000n });
    expect(
      await ledger.tryReserve([{ target: scratch, futureBytes: 1n }]),
    ).toBeNull();
    ledger.assertNoLocalReservations();
    readings.set("/fixture/cache", { device: 1n, availableBytes: 1000n });
    reader.mockRejectedValueOnce(new Error("private path and errno"));
    expect(
      await ledger.tryReserve([{ target: scratch, futureBytes: 1n }]),
    ).toBeNull();
    ledger.assertNoLocalReservations();
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: 1n },
    ]);
    receipt.release();
  });

  it("rejects malformed readings at registration and each later admission", async () => {
    const { ledger, scratch, reader } = await fixture();
    for (const reading of [
      { device: -1n, availableBytes: 1000n },
      { device: 1n, availableBytes: -1n },
      { device: 1 as unknown as bigint, availableBytes: 1000n },
    ]) {
      reader.mockResolvedValueOnce(reading);
      expect(
        await ledger.tryReserve([{ target: scratch, futureBytes: 1n }]),
      ).toBeNull();
    }
    ledger.assertNoLocalReservations();
    reader.mockRejectedValueOnce(new Error("sensitive host path"));
    await expect(ledger.registerRoot("/fixture/extra", 1n)).rejects.toThrow(
      "CONFIG_SCRATCH_UNUSABLE",
    );
  });

  it("keeps complete recovered reservations conservative and replaces them atomically", async () => {
    const { ledger, scratch } = await fixture();
    ledger.replaceRecoveredReservation("media-export-recovery", [
      { target: scratch, futureBytes: 700n },
    ]);
    expect(
      await ledger.tryReserve([{ target: scratch, futureBytes: 151n }]),
    ).toBeNull();
    expect(() =>
      ledger.replaceRecoveredReservation("media-export-recovery", [
        { target: scratch, futureBytes: -1n },
      ]),
    ).toThrow();
    expect(
      await ledger.tryReserve([{ target: scratch, futureBytes: 151n }]),
    ).toBeNull();
    // Recovered holds are not process-local leaks.
    ledger.assertNoLocalReservations();
    ledger.replaceRecoveredReservation("media-export-recovery", [
      { target: scratch, futureBytes: 100n },
    ]);
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: 750n },
    ]);
    receipt.release();
    ledger.replaceRecoveredReservation("media-export-recovery", []);
    ledger.assertNoLocalReservations();
  });

  it("excludes only the current provisional token and does not subtract frame safety twice", async () => {
    const { ledger, scratch } = await fixture();
    ledger.replaceRecoveredReservation("media-export-recovery", [
      { target: scratch, futureBytes: 100n },
    ]);
    const other = await reserve(ledger, [
      { target: scratch, futureBytes: 200n },
    ]);
    const frame = await reserve(ledger, [
      { target: scratch, futureBytes: 300n },
    ]);
    expect(await frame.availableForExistingFrameClaim(scratch)).toBe(700n);
    frame.release();
    await expect(frame.availableForExistingFrameClaim(scratch)).rejects.toThrow(
      "FILESYSTEM_CAPACITY_RESERVATION_INVALID",
    );
    other.release();
    ledger.assertNoLocalReservations();
  });

  it("returns zero frame availability when the device becomes unusable", async () => {
    const { ledger, scratch, reader } = await fixture();
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: 100n },
    ]);
    reader.mockRejectedValueOnce(new Error("private host path"));
    expect(await receipt.availableForExistingFrameClaim(scratch)).toBe(0n);
    receipt.release();
    ledger.assertNoLocalReservations();
  });

  it("uses BigInt rather than lossy Number capacity arithmetic", async () => {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER) + 1_000_000n;
    const { ledger, scratch } = await fixture(false, maximum);
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: maximum - 150n },
    ]);
    expect(await receipt.availableForExistingFrameClaim(scratch)).toBe(maximum);
    expect(
      await ledger.tryReserve([{ target: scratch, futureBytes: 1n }]),
    ).toBeNull();
    receipt.release();
  });

  it("does not let caller mutation change the bytes owned by a receipt", async () => {
    const { ledger, scratch } = await fixture();
    const request = { target: scratch, futureBytes: 500n };
    const receipt = await reserve(ledger, [request]);
    request.futureBytes = 0n;
    expect(receipt.requests[0]!.futureBytes).toBe(500n);
    receipt.release();
    const next = await reserve(ledger, [
      { target: scratch, futureBytes: 850n },
    ]);
    next.release();
    ledger.assertNoLocalReservations();
  });

  it("rejects forged targets, invalid requests and unrelated partial releases", async () => {
    const { ledger, scratch, cache } = await fixture();
    await expect(ledger.tryReserve([])).rejects.toThrow(
      "FILESYSTEM_CAPACITY_REQUEST_INVALID",
    );
    await expect(
      ledger.tryReserve([{ target: scratch, futureBytes: -1n }]),
    ).rejects.toThrow();
    await expect(
      ledger.tryReserve([{ target: { ...scratch }, futureBytes: 1n }]),
    ).rejects.toThrow();
    const receipt = await reserve(ledger, [
      { target: scratch, futureBytes: 1n },
    ]);
    expect(() => receipt.releaseTarget(cache)).toThrow(
      "FILESYSTEM_CAPACITY_REQUEST_INVALID",
    );
    receipt.release();
    ledger.assertNoLocalReservations();
  });

  it("rejects lexical protected and noncanonical roots before reader calls", async () => {
    const reader = vi.fn();
    const ledger = new LocalFilesystemCapacityLedger(reader);
    for (const root of [
      "relative",
      "/fixture/a/../b",
      "/fixture/Seanova/cache",
      "/fixture/Seánova/cache",
      "/fixture/DockerServer/cache",
    ])
      await expect(ledger.registerRoot(root, 0n)).rejects.toThrow(
        "CONFIG_SCRATCH_UNUSABLE",
      );
    expect(reader).not.toHaveBeenCalled();
  });
});
