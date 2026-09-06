import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { MediaJobRepository } from "../application/ports.js";

interface ScratchMarker {
  markerVersion: "editorial-export-scratch-v1";
  jobId: string;
  attemptNumber: number;
  leaseIdentityHash: string;
  createdAt: string;
  reservedBytes: string;
}

export class ExportScratchReconciler {
  constructor(
    private readonly repository: MediaJobRepository,
    private readonly scratchRoot: string,
    private readonly safetyGraceMs: number,
    private readonly telemetry: (event: Record<string, unknown>) => void = () =>
      undefined,
  ) {}

  async reconcile(): Promise<bigint> {
    const durable = await this.durableReservations();
    const durableByDirectory = new Map(
      durable.map((reservation) => [reservation.directoryName, reservation]),
    );
    let accounted = durable.reduce(
      (total, reservation) => total + reservation.reservedBytes,
      0n,
    );
    const entries = await readdir(this.scratchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("export-")) continue;
      const directory = join(this.scratchRoot, entry.name);
      const marker = await this.readMarker(directory, entry.name);
      if (!marker) continue;
      const reserved = BigInt(marker.reservedBytes);
      const durableReservation = durableByDirectory.get(entry.name);
      const accountMarker = () => {
        if (!durableReservation) accounted += reserved;
        else if (reserved > durableReservation.reservedBytes)
          accounted += reserved - durableReservation.reservedBytes;
      };
      const state = await this.repository.inspectExportScratchLease({
        jobId: marker.jobId,
        attemptNumber: marker.attemptNumber,
        leaseHash: marker.leaseIdentityHash,
        directoryName: entry.name,
      });
      if (state === "ACTIVE" || state === "UNKNOWN") {
        accountMarker();
        continue;
      }
      const created = Date.parse(marker.createdAt);
      if (
        !Number.isFinite(created) ||
        Date.now() - created < this.safetyGraceMs
      ) {
        accountMarker();
        continue;
      }
      try {
        await rm(directory, { recursive: true, force: true });
        await this.repository.clearReconciledExportScratch({
          jobId: marker.jobId,
          attemptNumber: marker.attemptNumber,
          directoryName: entry.name,
          leaseHash: marker.leaseIdentityHash,
        });
        this.telemetry({
          event: "export_scratch_orphan_removed",
          jobId: marker.jobId,
          attemptNumber: marker.attemptNumber,
          reservedBytes: marker.reservedBytes,
        });
      } catch (error) {
        accountMarker();
        this.telemetry({
          event: "export_scratch_cleanup_failed",
          jobId: marker.jobId,
          attemptNumber: marker.attemptNumber,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return accounted;
  }

  private async durableReservations() {
    try {
      return await this.repository.listActiveExportScratchReservations();
    } catch (error) {
      this.telemetry({
        event: "export_scratch_reservation_rebuild_failed",
        error: error instanceof Error ? error.message : "unknown",
      });
      throw error;
    }
  }

  private async readMarker(
    directory: string,
    directoryName: string,
  ): Promise<ScratchMarker | null> {
    try {
      const value = JSON.parse(
        await readFile(join(directory, "attempt.json"), "utf8"),
      ) as Partial<ScratchMarker>;
      if (
        value.markerVersion !== "editorial-export-scratch-v1" ||
        typeof value.jobId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.jobId,
        ) ||
        !Number.isSafeInteger(value.attemptNumber) ||
        (value.attemptNumber ?? 0) < 1 ||
        typeof value.leaseIdentityHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.leaseIdentityHash) ||
        typeof value.createdAt !== "string" ||
        typeof value.reservedBytes !== "string" ||
        !/^[1-9]\d*$/.test(value.reservedBytes) ||
        directoryName !==
          `export-${value.jobId}-${value.attemptNumber}-${value.leaseIdentityHash.slice(0, 16)}`
      ) {
        this.telemetry({
          event: "export_scratch_marker_unrecognized",
          directoryName,
        });
        return null;
      }
      return value as ScratchMarker;
    } catch {
      this.telemetry({
        event: "export_scratch_marker_unrecognized",
        directoryName,
      });
      return null;
    }
  }
}
