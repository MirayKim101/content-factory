import { stat, statfs } from "node:fs/promises";
import {
  LocalFilesystemCapacityLedger,
  type FilesystemCapacityReader,
} from "../src/infrastructure/local-filesystem-capacity-ledger.js";

/** Tests explicitly choose their filesystem reader. Production registers only
 * preflighted private roots through the default strict reader in main.ts. */
export async function testCapacity(
  directory: string,
  safety = 0n,
  read?: FilesystemCapacityReader,
) {
  const capacityLedger = new LocalFilesystemCapacityLedger(
    read ??
      (async () => {
        const root = await stat(directory, { bigint: true });
        const disk = await statfs(directory, { bigint: true });
        return { device: root.dev, availableBytes: disk.bavail * disk.bsize };
      }),
  );
  const scratchTarget = await capacityLedger.registerRoot(directory, safety);
  const cacheTarget = await capacityLedger.registerRoot(directory, safety);
  return {
    capacityLedger,
    scratchTarget,
    cacheTarget,
    outputTarget: scratchTarget,
  };
}
