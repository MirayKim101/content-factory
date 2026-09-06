import { z } from "zod";

const schema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
});
const prefix = "content-factory:editorial-export-attempt:v1:";

function key(approvalId: string): string {
  return `${prefix}${approvalId}`;
}
function storage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function loadExportAttempt(approvalId: string): string | undefined {
  const target = key(approvalId);
  const value = storage()?.getItem(target);
  if (!value) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data.idempotencyKey;
  } catch {
    // Handled below: malformed durable browser state must not create an
    // endless 400 retry loop against the server's Idempotency-Key contract.
  }
  storage()?.removeItem(target);
  return undefined;
}
export function saveExportAttempt(
  approvalId: string,
  idempotencyKey: string,
): void {
  storage()?.setItem(
    key(approvalId),
    JSON.stringify(schema.parse({ idempotencyKey })),
  );
}
export function clearExportAttempt(approvalId: string): void {
  storage()?.removeItem(key(approvalId));
}
export function exportIdempotency(approvalId: string): string {
  return loadExportAttempt(approvalId) ?? crypto.randomUUID();
}
