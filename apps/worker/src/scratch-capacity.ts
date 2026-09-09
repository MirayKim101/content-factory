import { mkdir, statfs } from "node:fs/promises";

import type { ScratchCapacity } from "@content-factory/manual-cut";

export class FilesystemScratchCapacity implements ScratchCapacity {
  constructor(
    private readonly directory: string,
    private readonly maximumBytes: bigint,
  ) {}

  async inspect(requiredBytes: bigint) {
    await mkdir(this.directory, { recursive: true });
    const stats = await statfs(this.directory);
    const freeBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
    if (requiredBytes > this.maximumBytes)
      return { outcome: "IMPOSSIBLE" as const };
    if (requiredBytes > freeBytes)
      return { outcome: "TEMPORARY_PRESSURE" as const };
    return {
      outcome: "AVAILABLE" as const,
      usableBytes:
        freeBytes < this.maximumBytes ? freeBytes : this.maximumBytes,
    };
  }
}
