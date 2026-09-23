import { describe, expect, it, vi } from "vitest";
import { TranscriptEvidenceController } from "../src/ai-content/presentation/transcript-evidence.controller.js";

const cutJobId = "11111111-1111-4111-8111-111111111111";
const contextId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";

describe("TranscriptEvidenceController", () => {
  it("creates a queued intent and returns its public detail", async () => {
    const repository = {
      create: vi.fn().mockResolvedValue("44444444-4444-4444-8444-444444444444"),
      detail: vi.fn().mockResolvedValue({
        id: "44444444-4444-4444-8444-444444444444",
        state: "QUEUED",
        contractVersion: "editorial-transcript-v1",
        adapterVersion: "local-manual-transcript-v1",
        language: "ru",
        input: {},
        artifact: null,
        failure: null,
      }),
    };
    const controller = new TranscriptEvidenceController(repository as never);
    const result = await controller.create(cutJobId, "transcript-test-1", {
      sourceContextRevisionId: contextId,
      cutPromptRevisionId: promptId,
      language: "ru",
      fixture: { language: "ru", segments: [] },
    });
    expect(result.state).toBe("QUEUED");
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ cutPipelineJobId: cutJobId }),
    );
  });

  it("rejects malformed idempotency keys before persistence", async () => {
    const repository = { create: vi.fn(), detail: vi.fn() };
    const controller = new TranscriptEvidenceController(repository as never);
    await expect(
      controller.create(cutJobId, "bad", {} as never),
    ).rejects.toMatchObject({ response: { code: "IDEMPOTENCY_KEY_INVALID" } });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
