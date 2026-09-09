import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MediaJobRepository } from "../application/ports.js";

interface MediaScratchMarker {
  markerVersion: "media-attempt-scratch-v1";
  jobId: string;
  attemptNumber: number;
  createdAt: string;
}

interface MediaScratchCandidate extends MediaScratchMarker {
  directoryName: string;
}

export class MediaScratchReconciler {
  constructor(
    private readonly repository: MediaJobRepository,
    private readonly scratchRoot: string,
    private readonly safetyGraceMs: number,
    private readonly telemetry: (event: Record<string, unknown>) => void = () =>
      undefined,
  ) {}

  async reconcile(): Promise<number> {
    const entries = await readdir(this.scratchRoot, { withFileTypes: true });
    const candidates: MediaScratchCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const identity = parseDirectoryIdentity(entry.name);
      if (!identity) continue;
      const createdAt = await this.createdAt(entry.name, identity);
      if (createdAt === null || Date.now() - createdAt < this.safetyGraceMs)
        continue;
      candidates.push({
        markerVersion: "media-attempt-scratch-v1",
        ...identity,
        createdAt: new Date(createdAt).toISOString(),
        directoryName: entry.name,
      });
    }

    let removed = 0;
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const terminal =
        await this.repository.findTerminalMediaScratchDirectories(
          candidates.slice(offset, offset + 100),
        );
      for (const directoryName of terminal) {
        await rm(join(this.scratchRoot, directoryName), {
          recursive: true,
          force: true,
        });
        removed += 1;
        this.telemetry({ event: "media_scratch_orphan_removed" });
      }
    }
    return removed;
  }

  private async createdAt(
    directoryName: string,
    identity: { jobId: string; attemptNumber: number },
  ): Promise<number | null> {
    try {
      const marker = JSON.parse(
        await readFile(
          join(this.scratchRoot, directoryName, "attempt.json"),
          "utf8",
        ),
      ) as Partial<MediaScratchMarker>;
      const createdAt = Date.parse(marker.createdAt ?? "");
      if (
        marker.markerVersion !== "media-attempt-scratch-v1" ||
        marker.jobId !== identity.jobId ||
        marker.attemptNumber !== identity.attemptNumber ||
        !Number.isFinite(createdAt)
      )
        throw new Error("MEDIA_SCRATCH_MARKER_INVALID");
      return createdAt;
    } catch {
      try {
        return (await stat(join(this.scratchRoot, directoryName))).mtimeMs;
      } catch {
        return null;
      }
    }
  }
}

function parseDirectoryIdentity(
  directoryName: string,
): { jobId: string; attemptNumber: number } | null {
  const match =
    /^content-factory-media-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([1-9]\d*)$/i.exec(
      directoryName,
    );
  if (!match?.[1] || !match[2]) return null;
  const attemptNumber = Number(match[2]);
  return Number.isSafeInteger(attemptNumber)
    ? { jobId: match[1], attemptNumber }
    : null;
}
