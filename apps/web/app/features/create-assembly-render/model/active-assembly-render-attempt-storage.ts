const storagePrefix = "content-factory.assembly-render-attempt.v1";

export interface AssemblyRenderAttempt {
  recipeRevision: number;
  key: string;
}

function storageKey(jobId: string): string {
  return `${storagePrefix}:${jobId}`;
}

export function loadAssemblyRenderAttempt(
  jobId: string,
): AssemblyRenderAttempt | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(jobId)) ?? "null",
    );
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Partial<AssemblyRenderAttempt>;
    const revision = candidate.recipeRevision;
    return typeof candidate.key === "string" &&
      candidate.key.length > 0 &&
      typeof revision === "number" &&
      Number.isInteger(revision) &&
      revision > 0
      ? { key: candidate.key, recipeRevision: revision }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveAssemblyRenderAttempt(
  jobId: string,
  attempt: AssemblyRenderAttempt,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(jobId), JSON.stringify(attempt));
  } catch {
    /* Recovery stays server-authoritative. */
  }
}

export function clearAssemblyRenderAttempt(jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(jobId));
  } catch {
    /* no-op */
  }
}
