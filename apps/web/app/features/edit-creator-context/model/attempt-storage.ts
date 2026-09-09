import { z } from "zod";

const schema = z.object({ fingerprint: z.string(), key: z.uuid() });

export class CreatorOperationStorageError extends Error {
  constructor() { super("Не удалось безопасно сохранить ключ повтора. Повторите действие после восстановления хранилища браузера."); }
}

/** Persists one exact mutation identity across a reload; a changed target/body gets a new key. */
export function creatorOperationKey(operation: string, target: string, body: unknown): string {
  const fingerprint = `${operation}:${target}:${JSON.stringify(body)}`;
  const storageKey = `content-factory.creator-context.${operation}.${target}`;
  let stored: unknown;
  if (typeof sessionStorage !== "undefined") {
    try { stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null"); } catch { throw new CreatorOperationStorageError(); }
  }
  const existing = schema.safeParse(stored);
  if (existing?.success && existing.data.fingerprint === fingerprint) return existing.data.key;
  const key = crypto.randomUUID();
  if (typeof sessionStorage !== "undefined") {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key })); } catch { throw new CreatorOperationStorageError(); }
  }
  return key;
}
export function clearCreatorOperationKey(operation: string, target: string): void {
  if (typeof sessionStorage !== "undefined") {
    try { sessionStorage.removeItem(`content-factory.creator-context.${operation}.${target}`); } catch { /* completed request remains safe server-side */ }
  }
}
