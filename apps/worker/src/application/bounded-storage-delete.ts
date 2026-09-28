import { createAbortDeadline } from "./abort-deadline.js";
import type { WorkerObjectStorage } from "./ports.js";

const DEFAULT_STORAGE_DELETE_TIMEOUT_MS = 30_000;

export async function deleteStorageObjectBestEffort(
  storage: Pick<WorkerObjectStorage, "delete">,
  objectKey: string,
  timeoutMs = DEFAULT_STORAGE_DELETE_TIMEOUT_MS,
): Promise<void> {
  const parent = new AbortController();
  const deadline = createAbortDeadline(
    parent.signal,
    timeoutMs,
    "STORAGE_DELETE_TIMEOUT",
  );
  try {
    await storage.delete(objectKey, deadline.signal);
  } catch {
    // The durable row was not committed, so this remains a best-effort orphan
    // cleanup. Never let an unavailable object store block worker shutdown.
  } finally {
    deadline.dispose();
  }
}
