import { z } from "zod";

const schema = z.object({
  candidateFingerprint: z.string().min(1),
  manualAttentionMs: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).optional(),
});
type ApprovalDraft = z.infer<typeof schema>;
const prefix = "content-factory:editorial-approval-draft:v1:";

function key(cutJobId: string): string {
  return `${prefix}${cutJobId}`;
}
function storage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
export function loadApprovalDraft(
  cutJobId: string,
  candidateFingerprint: string,
): ApprovalDraft {
  const value = storage()?.getItem(key(cutJobId));
  if (!value) return { candidateFingerprint, manualAttentionMs: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { candidateFingerprint, manualAttentionMs: 0 };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success &&
    parsed.data.candidateFingerprint === candidateFingerprint
    ? parsed.data
    : { candidateFingerprint, manualAttentionMs: 0 };
}
export function saveApprovalDraft(
  cutJobId: string,
  draft: ApprovalDraft,
): void {
  storage()?.setItem(key(cutJobId), JSON.stringify(schema.parse(draft)));
}
export function clearApprovalDraft(cutJobId: string): void {
  storage()?.removeItem(key(cutJobId));
}
export function approvalIdempotency(draft: ApprovalDraft): ApprovalDraft {
  return draft.idempotencyKey
    ? draft
    : { ...draft, idempotencyKey: crypto.randomUUID() };
}
