import { z } from "zod";

const schema = z.object({
  candidateFingerprint: z.string().min(1),
  preparationForegroundMs: z.number().int().nonnegative(),
  finalReviewForegroundMs: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).optional(),
});
type ApprovalDraft = z.infer<typeof schema>;
const legacySchema = z.object({
  candidateFingerprint: z.string().min(1),
  manualAttentionMs: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).optional(),
});
const prefix = "content-factory:editorial-approval-draft:v2:";

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
  if (!value)
    return {
      candidateFingerprint,
      preparationForegroundMs: 0,
      finalReviewForegroundMs: 0,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return {
      candidateFingerprint,
      preparationForegroundMs: 0,
      finalReviewForegroundMs: 0,
    };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success &&
    parsed.data.candidateFingerprint === candidateFingerprint
    ? parsed.data
    : legacyDraft(raw, candidateFingerprint);
}

function legacyDraft(
  raw: unknown,
  candidateFingerprint: string,
): ApprovalDraft {
  const parsed = legacySchema.safeParse(raw);
  if (
    parsed.success &&
    parsed.data.candidateFingerprint === candidateFingerprint
  )
    return {
      candidateFingerprint,
      preparationForegroundMs: parsed.data.manualAttentionMs,
      finalReviewForegroundMs: 0,
      idempotencyKey: parsed.data.idempotencyKey,
    };
  return {
    candidateFingerprint,
    preparationForegroundMs: 0,
    finalReviewForegroundMs: 0,
  };
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
