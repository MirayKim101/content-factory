import type { SaveEditorialPackage } from "~/shared/api/editorial-content";

export interface EditorialSaveAttempt {
  fingerprint: string;
  key: string;
}

export interface EditorialOperationAttempt {
  fingerprint: string;
  key: string;
}

export function idempotencyForEditorialOperation(
  current: EditorialOperationAttempt | undefined,
  fingerprint: string,
  createKey: () => string,
): EditorialOperationAttempt {
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: createKey() };
}

export async function thumbnailFileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function thumbnailUploadFingerprint(
  projectId: string,
  file: File,
): Promise<string> {
  return JSON.stringify({
    projectId,
    originalFilename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    sha256: await thumbnailFileFingerprint(file),
  });
}

export function idempotencyForEditorialSave(
  current: EditorialSaveAttempt | undefined,
  payload: SaveEditorialPackage,
  createKey: () => string,
): EditorialSaveAttempt {
  const fingerprint = JSON.stringify(payload);
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: createKey() };
}
