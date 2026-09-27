import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function prepareWorkerReadiness(
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
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
): Promise<void> {
  await unlink(readinessFile).catch(() => undefined);
}
