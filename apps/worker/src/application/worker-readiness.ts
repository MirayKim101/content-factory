import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ScratchCapabilityError,
  verifyScratchCapability,
} from "../infrastructure/scratch-capability.js";

export async function prepareWorkerReadiness(
  directory: string,
): Promise<string> {
  await verifyScratchCapability(directory);
  const readinessFile = join(directory, "worker-ready");
  await clearWorkerReadiness(readinessFile);
  return readinessFile;
}

export async function markWorkerReady(readinessFile: string): Promise<void> {
  await writeFile(readinessFile, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearWorkerReadiness(
  readinessFile: string,
  remove: (path: string) => Promise<void> = unlink,
): Promise<void> {
  await remove(readinessFile).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ScratchCapabilityError();
  });
}

/** Report failure without preventing the caller from closing queues/clients.
 * Every shutdown caller must retain a non-zero exit status when false. */
export async function tryClearWorkerReadiness(
  readinessFile: string,
  remove: (path: string) => Promise<void> = unlink,
): Promise<boolean> {
  try {
    await clearWorkerReadiness(readinessFile, remove);
    return true;
  } catch {
    console.error(
      JSON.stringify({
        event: "worker_readiness_clear_failed",
        code: "CONFIG_SCRATCH_UNUSABLE",
      }),
    );
    return false;
  }
}
