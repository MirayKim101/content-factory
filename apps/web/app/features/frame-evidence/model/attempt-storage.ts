import { z } from "zod";
import {
  frameRequestSchema,
  frameScopeSchema,
  type FrameRequest,
  type FrameScope,
} from "~/shared/api/frame-evidence";
const pendingSchema = z.object({
  scope: frameScopeSchema,
  body: frameRequestSchema,
  key: z.uuid(),
});
export type PendingFrameRequest = z.infer<typeof pendingSchema>;
const storageKey = (scope: FrameScope) =>
  `content-factory.frames.pending.${scope.projectId}.${scope.cutPipelineJobId}`;
const failure = () =>
  new Error(
    "Не удалось прочитать или сохранить ключ запроса в браузере. Восстановите доступ к хранилищу и обновите окно.",
  );
export function readPendingFrameRequest(
  scope: FrameScope,
): PendingFrameRequest | null {
  try {
    const raw = sessionStorage.getItem(storageKey(scope));
    if (raw === null) return null;
    const stored = pendingSchema.parse(JSON.parse(raw));
    if (
      JSON.stringify(stored.scope) !==
      JSON.stringify(frameScopeSchema.parse(scope))
    )
      throw failure();
    return stored;
  } catch {
    throw failure();
  }
}
export function beginFrameRequest(
  scope: FrameScope,
  body: FrameRequest,
): PendingFrameRequest {
  const previous = readPendingFrameRequest(scope);
  if (previous) return previous;
  const pending = pendingSchema.parse({
    scope,
    body,
    key: crypto.randomUUID(),
  });
  try {
    sessionStorage.setItem(storageKey(scope), JSON.stringify(pending));
  } catch {
    throw failure();
  }
  return pending;
}
export function finishFrameRequest(pending: PendingFrameRequest): void {
  try {
    if (readPendingFrameRequest(pending.scope)?.key === pending.key)
      sessionStorage.removeItem(storageKey(pending.scope));
  } catch {
    /* A retained key safely replays the confirmed result. */
  }
}
