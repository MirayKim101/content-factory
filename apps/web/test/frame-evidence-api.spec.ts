import { describe, expect, it, vi } from "vitest";
import { createFrameEvidenceApi } from "~/shared/api/frame-evidence";
import { evidence, frameBody, scope } from "./frame-evidence-fixtures";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("frame evidence API boundary", () => {
  it("posts exact context revisions with the supplied replay key and checks scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(evidence(), 202));
    await createFrameEvidenceApi("/api/v1", fetcher).create(
      scope,
      frameBody,
      "stable-key",
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/pipeline-jobs/${scope.cutPipelineJobId}/frame-evidence`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(frameBody),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "stable-key",
        },
      }),
    );
  });
  it("rejects cross-cut list metadata before it is rendered", async () => {
    const item = evidence();
    item.identity.cutPipelineJobId = item.id;
    const api = createFrameEvidenceApi(
      "/api/v1",
      vi.fn().mockResolvedValue(response({ items: [item], nextCursor: null })),
    );
    await expect(api.list(scope)).rejects.toMatchObject({
      code: "FRAME_SCOPE_MISMATCH",
    });
  });
  it("rejects a READY result with only two frames", async () => {
    const item = evidence();
    item.frames.pop();
    const api = createFrameEvidenceApi(
      "/api/v1",
      vi.fn().mockResolvedValue(response(item)),
    );
    await expect(api.get(item.id, scope)).rejects.toMatchObject({
      code: "API_RESPONSE_INVALID",
    });
  });
  it("preserves typed source-rights rejection", async () => {
    const api = createFrameEvidenceApi(
      "/api/v1",
      vi
        .fn()
        .mockResolvedValue(
          response(
            {
              error: {
                code: "SOURCE_AUTHORIZATION_REQUIRED",
                message: "Нет разрешения",
              },
            },
            409,
          ),
        ),
    );
    await expect(
      api.create(scope, frameBody, "stable-key"),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_AUTHORIZATION_REQUIRED",
    });
  });
  it("treats a lost response as unknown and never retries POST itself", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("lost"));
    await expect(
      createFrameEvidenceApi("/api/v1", fetcher).create(
        scope,
        frameBody,
        "stable-key",
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not accept a replay for different context revisions", async () => {
    const item = evidence();
    item.identity.cutPromptRevisionId = item.id;
    await expect(
      createFrameEvidenceApi(
        "/api/v1",
        vi.fn().mockResolvedValue(response(item)),
      ).create(scope, frameBody, "stable-key"),
    ).rejects.toMatchObject({ code: "FRAME_SCOPE_MISMATCH" });
  });
});
