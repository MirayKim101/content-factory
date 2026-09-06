import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approvalIdempotency,
  clearApprovalDraft,
  loadApprovalDraft,
  saveApprovalDraft,
} from "~/features/review-editorial-package/model/approval-draft";

const cutA = "00000000-0000-4000-8000-000000000001";

describe("editorial approval review draft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: () => "stable-approval-key" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores attention and the same idempotency key after closing and reopening one exact candidate", () => {
    saveApprovalDraft(cutA, {
      candidateFingerprint: "candidate-a",
      manualAttentionMs: 12_000,
      idempotencyKey: "saved-key",
    });
    expect(loadApprovalDraft(cutA, "candidate-a")).toEqual({
      candidateFingerprint: "candidate-a",
      manualAttentionMs: 12_000,
      idempotencyKey: "saved-key",
    });
  });

  it("never carries manual attention or replay identity to a changed candidate", () => {
    saveApprovalDraft(cutA, {
      candidateFingerprint: "candidate-a",
      manualAttentionMs: 12_000,
      idempotencyKey: "saved-key",
    });
    expect(loadApprovalDraft(cutA, "candidate-b")).toEqual({
      candidateFingerprint: "candidate-b",
      manualAttentionMs: 0,
    });
  });

  it("fails closed when durable browser data is malformed", () => {
    window.localStorage.setItem(
      "content-factory:editorial-approval-draft:v1:" + cutA,
      "not-json",
    );
    expect(loadApprovalDraft(cutA, "candidate-a")).toEqual({
      candidateFingerprint: "candidate-a",
      manualAttentionMs: 0,
    });
  });

  it("keeps the exact idempotency key for ambiguous retry and clears it only after success", () => {
    const first = approvalIdempotency({
      candidateFingerprint: "candidate-a",
      manualAttentionMs: 1,
    });
    expect(first.idempotencyKey).toBe("stable-approval-key");
    expect(approvalIdempotency(first)).toEqual(first);
    saveApprovalDraft(cutA, first);
    clearApprovalDraft(cutA);
    expect(
      loadApprovalDraft(cutA, "candidate-a").idempotencyKey,
    ).toBeUndefined();
  });
});
