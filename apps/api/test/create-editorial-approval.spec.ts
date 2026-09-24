import { describe, expect, it, vi } from "vitest";

import type { EditorialApprovalRepository } from "../src/editorial-content/application/editorial-approval-repository.port.js";
import { CreateEditorialApproval } from "../src/editorial-content/application/create-editorial-approval.js";

const input = {
  renderId: "ef703380-656e-4f15-9c5e-f722c7bbe01b",
  editorialRevision: 3,
  candidateFingerprint: "a".repeat(64),
  approvalContractVersion: "manual-horizontal-approval-v1" as const,
  manualAttentionMs: 245_000,
  attentionMeasurementVersion: "foreground-preview-v1" as const,
  idempotencyKey: "approval-request-1",
};

describe("CreateEditorialApproval", () => {
  it("delegates one immutable approval request without any job dispatch", async () => {
    const view = { id: "approval-id" } as never;
    const repository = {
      create: vi.fn(async (value) => {
        expect(value.approvalId).toMatch(/^[a-f0-9-]{36}$/);
        expect(value.operationRequestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(value).toMatchObject(input);
        return view;
      }),
    } as unknown as EditorialApprovalRepository;
    const useCase = new CreateEditorialApproval(repository, true);
    await expect(useCase.execute(input)).resolves.toBe(view);
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it("does not persist while rollout admission is disabled", async () => {
    const repository = {
      create: vi.fn(),
    } as unknown as EditorialApprovalRepository;
    const useCase = new CreateEditorialApproval(repository, false);
    expect(() => useCase.execute(input)).toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("keeps v2 admission independently default-off and forwards exact two-phase attention when enabled", async () => {
    const repository = {
      create: vi.fn(async () => ({ id: "approval-v2" }) as never),
    } as unknown as EditorialApprovalRepository;
    const request = {
      renderId: input.renderId,
      editorialRevision: 4,
      candidateFingerprint: "b".repeat(64),
      approvalContractVersion: "human-horizontal-approval-v2" as const,
      attention: {
        schemaVersion: "operator-attention-v2" as const,
        preparationForegroundMs: 120_000,
        finalReviewForegroundMs: 45_000,
      },
      idempotencyKey: "approval-request-v2",
    };
    expect(() =>
      new CreateEditorialApproval(repository, true).execute(request),
    ).toThrow();
    await new CreateEditorialApproval(repository, true, true).execute(request);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ attention: request.attention }),
    );
  });
});
