import { describe, expect, it, vi } from "vitest";
import { TranscriptEvidenceController } from "../src/ai-content/presentation/transcript-evidence.controller.js";

const cutJobId = "11111111-1111-4111-8111-111111111111";
const contextId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";

describe("TranscriptEvidenceController", () => {
  it("returns the latest transcript linked to a cut job", async () => {
    const latest = {
      id: "44444444-4444-4444-8444-444444444444",
      state: "READY",
      artifact: {
        id: "55555555-5555-4555-8555-555555555555",
        contentType: "application/json",
        sizeBytes: 32,
        sha256: "a".repeat(64),
        adapterVersion: "local-manual-transcript-v1",
        language: "ru",
        segments: [{ ordinal: 0, startMs: 0, endMs: 1, text: "private" }],
      },
    };
    const repository = {
      latestForJob: vi.fn().mockResolvedValue(latest),
    };
    const controller = new TranscriptEvidenceController(
      repository as never,
      { dispatch: vi.fn() },
      { readObject: vi.fn() } as never,
    );

    const result = await controller.latestForJob(cutJobId);
    expect(result).not.toBeNull();
    expect(result!.artifact).not.toHaveProperty("segments");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(repository.latestForJob).toHaveBeenCalledWith(cutJobId);
  });

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
    const dispatch = { dispatch: vi.fn().mockResolvedValue(undefined) };
    const storage = { readObject: vi.fn() };
    const controller = new TranscriptEvidenceController(
      repository as never,
      dispatch,
      storage as never,
    );
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
    const controller = new TranscriptEvidenceController(
      repository as never,
      { dispatch: vi.fn() },
      { readObject: vi.fn() } as never,
    );
    await expect(
      controller.create(cutJobId, "bad", {} as never),
    ).rejects.toMatchObject({ response: { code: "IDEMPOTENCY_KEY_INVALID" } });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
