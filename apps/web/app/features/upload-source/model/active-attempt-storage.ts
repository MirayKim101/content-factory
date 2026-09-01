import { z } from "zod";

const key = "content-factory.active-source-upload.v1";
const schema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  projectId: z.uuid().optional(),
  name: z.string().min(1).max(200),
  fingerprint: z.object({
    size: z.number().nonnegative(),
    lastModified: z.number().int(),
    type: z.string(),
  }),
  status: z.enum(["SENDING", "SOURCE_PENDING"]),
});
export type ActiveAttempt = z.infer<typeof schema>;

function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
export function loadActiveAttempt(
  storage: Storage | null = browserStorage(),
): ActiveAttempt | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* discard corrupt JSON */
  }
  try {
    storage.removeItem(key);
  } catch {
    /* degraded storage */
  }
  return null;
}
export function saveActiveAttempt(
  value: ActiveAttempt,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* degraded storage */
  }
}
export function clearActiveAttempt(
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* degraded storage */
  }
}
