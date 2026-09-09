import type { MontageUploadProgress } from "~/shared/api/montage-assets";

/** Progress is monotonic only inside one XHR attempt. Every retry starts at 0. */
export function nextMontageUploadProgress(
  current: number,
  progress: MontageUploadProgress,
): number {
  if (!Number.isFinite(progress.total) || progress.total <= 0) return current;
  const loaded = Math.min(Math.max(0, progress.loaded), progress.total);
  return Math.min(
    99,
    Math.max(current, Math.floor((loaded / progress.total) * 100)),
  );
}
