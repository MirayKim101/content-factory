import { z } from "zod";

const storageKey = "content-factory:last-source-gate:v1";
const storedGateSchema = z.object({ projectId: z.uuid() });

function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function saveLastSourceGate(
  projectId: string,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(storageKey, JSON.stringify({ projectId }));
  } catch {
    /* degraded storage must not interrupt server-state recovery */
  }
}

export function loadLastSourceGate(
  storage: Storage | null = browserStorage(),
): string | null {
  if (!storage) return null;
  let value: string | null;
  try {
    value = storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!value) return null;
  try {
    const parsed = storedGateSchema.safeParse(JSON.parse(value) as unknown);
    if (parsed.success) return parsed.data.projectId;
  } catch {
    /* remove corrupt JSON below */
  }
  try {
    storage.removeItem(storageKey);
  } catch {
    /* degraded storage */
  }
  return null;
}
