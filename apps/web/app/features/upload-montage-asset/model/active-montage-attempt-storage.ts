import { z } from "zod";

import type { MontageAssetKind } from "~/shared/api/montage-assets";

const key = "content-factory.active-montage-upload.v1";
const schema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  projectId: z.uuid(),
  kind: z.enum(["ADVERTISEMENT", "INTRO", "OUTRO", "BANNER"]),
  fingerprint: z.object({
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    lastModified: z.number().int(),
    type: z.string(),
  }),
});

export type ActiveMontageAttempt = z.infer<typeof schema>;
export interface MontageFileFingerprint {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function fingerprintMontageFile(file: File): MontageFileFingerprint {
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
  };
}

export function matchesMontageAttempt(
  attempt: ActiveMontageAttempt,
  projectId: string,
  kind: MontageAssetKind,
  file: File,
): boolean {
  const fingerprint = fingerprintMontageFile(file);
  return (
    attempt.projectId === projectId &&
    attempt.kind === kind &&
    attempt.fingerprint.name === fingerprint.name &&
    attempt.fingerprint.size === fingerprint.size &&
    attempt.fingerprint.lastModified === fingerprint.lastModified &&
    attempt.fingerprint.type === fingerprint.type
  );
}

export function loadActiveMontageAttempt(
  storage: Storage | null = browserStorage(),
): ActiveMontageAttempt | null {
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

export function saveActiveMontageAttempt(
  value: ActiveMontageAttempt,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* degraded storage */
  }
}

export function clearActiveMontageAttempt(
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* degraded storage */
  }
}
