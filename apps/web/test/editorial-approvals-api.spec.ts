import { describe, expect, it } from "vitest";

import {
  createEditorialApprovalsApi,
  EditorialApprovalApiError,
} from "~/shared/api/editorial-approvals";

const cutId = "00000000-0000-4000-8000-000000000001";
const renderId = "00000000-0000-4000-8000-000000000002";

function failure(status: number) {
  return async () =>
    new Response(
      JSON.stringify({ error: { code: `HTTP_${status}`, message: "blocked" } }),
      { status },
    );
}

describe("editorial approvals API", () => {
  it.each([404, 409])(
    "keeps review HTTP %i explicit and never fabricates a candidate",
    async (status) => {
      const api = createEditorialApprovalsApi("/api/v1", failure(status));
      await expect(api.review(cutId)).rejects.toEqual(
        expect.objectContaining<Partial<EditorialApprovalApiError>>({
          code: `HTTP_${status}`,
          status,
        }),
      );
    },
  );

  it.each([404, 409, 503])(
    "keeps approval HTTP %i explicit for safe dialog handling",
    async (status) => {
      const api = createEditorialApprovalsApi("/api/v1", failure(status));
      await expect(
        api.approve(
          renderId,
          {
            editorialRevision: 1,
            candidateFingerprint: "a".repeat(64),
            manualAttentionMs: 0,
            attentionMeasurementVersion: "foreground-preview-v1",
          },
          "durable-key",
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<EditorialApprovalApiError>>({
          code: `HTTP_${status}`,
          status,
        }),
      );
    },
  );
});
