import { describe, expect, it, vi } from "vitest";

import type { EditorialApprovalRepository } from "../src/editorial-content/application/editorial-approval-repository.port.js";
import { CreateEditorialApproval } from "../src/editorial-content/application/create-editorial-approval.js";

const input = {
  renderId: "ef703380-656e-4f15-9c5e-f722c7bbe01b",
  editorialRevision: 3,
  candidateFingerprint: "a".repeat(64),
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
});
