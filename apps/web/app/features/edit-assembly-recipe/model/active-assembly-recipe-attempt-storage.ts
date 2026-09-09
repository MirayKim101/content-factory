import { z } from "zod";

import type { SaveAssemblyRecipe } from "~/shared/api/assembly-recipes";
import type { AssemblyRecipeSaveAttempt } from "~/features/edit-assembly-recipe/model/save-identity";

const storagePrefix = "content-factory.assembly-recipe-attempt.v1";
const schema = z.object({
  fingerprint: z.string().min(2),
  key: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
});

function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
function storageKey(jobId: string): string {
  return `${storagePrefix}:${jobId}`;
}
export function assemblyRecipeFingerprint(payload: SaveAssemblyRecipe): string {
  return JSON.stringify(payload);
}
export function loadAssemblyRecipeAttempt(
  jobId: string,
  storage: Storage | null = browserStorage(),
): AssemblyRecipeSaveAttempt | undefined {
  try {
    const raw = storage?.getItem(storageKey(jobId));
    if (!raw) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* storage is optional; a fresh idempotency key is still safe */
  }
  try {
    storage?.removeItem(storageKey(jobId));
  } catch {
    /* degraded storage */
  }
  return undefined;
}
export function saveAssemblyRecipeAttempt(
  jobId: string,
  attempt: AssemblyRecipeSaveAttempt,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(storageKey(jobId), JSON.stringify(attempt));
  } catch {
    /* degraded storage */
  }
}
export function clearAssemblyRecipeAttempt(
  jobId: string,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(storageKey(jobId));
  } catch {
    /* degraded storage */
  }
}
