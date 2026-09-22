import { describe, expect, it } from "vitest";

import { LocalManualTranscriptAdapter } from "../src/ai-content/transcript/local-transcript-adapter.js";
import {
  InMemoryTranscriptRepository,
  LocalTranscriptService,
} from "../src/ai-content/transcript/local-transcript-service.js";

const context = {
  projectId: "00000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000002",
  sourceVersion: 1,
  sourceSha256: "a".repeat(64),
  sourceAuthorizationRevision: 1,
  cutPipelineJobId: "00000000-0000-4000-8000-000000000003",
  cutResultArtifactId: "00000000-0000-4000-8000-000000000004",
  cutResultSha256: "b".repeat(64),
  cutResultSizeBytes: "1234",
  cutStartMs: 100,
  cutEndMs: 2_100,
  creatorProfileRevisionId: "00000000-0000-4000-8000-000000000005",
  creatorProfileRevisionNo: 1,
  sourceContextRevisionId: "00000000-0000-4000-8000-000000000006",
  sourceContextRevisionNo: 1,
  cutPromptRevisionId: "00000000-0000-4000-8000-000000000007",
  cutPromptRevisionNo: 1,
} as const;

describe("local transcript foundation", () => {
  it("produces a deterministic private artifact and rejects malformed input", () => {
    const adapter = new LocalManualTranscriptAdapter();
    const input = {
      language: "ru",
      segments: [{ ordinal: 0, startMs: 0, endMs: 1_000, text: "Привет" }],
    };
    const first = adapter.transcribe({
      fixture: input,
      durationMs: 2_000,
      artifactId: "a",
    });
    const second = adapter.transcribe({
      fixture: input,
      durationMs: 2_000,
      artifactId: "b",
    });
    expect(first.sha256).toBe(second.sha256);
    expect(adapter.serialize(first)).toHaveLength(first.sizeBytes);
    expect(() =>
      adapter.transcribe({
        fixture: { ...input, language: "bad language" },
        durationMs: 2_000,
        artifactId: "c",
      }),
    ).toThrow("TRANSCRIPT_LANGUAGE_INVALID");
  });

  it("keeps same-key replay idempotent and delivers READY once", async () => {
    const repository = new InMemoryTranscriptRepository();
    const service = new LocalTranscriptService(repository);
    const first = await service.create({
      idempotencyKey: "transcript-key",
      language: "ru",
      context,
    });
    expect(
      await service.create({
        idempotencyKey: "transcript-key",
        language: "ru",
        context,
      }),
    ).toBe(first);
    await service.deliver({
      id: first,
      fixture: {
        language: "ru",
        segments: [{ ordinal: 0, startMs: 0, endMs: 1_000, text: "Привет" }],
      },
    });
    const detail = await repository.detail(first);
    expect(detail?.state).toBe("READY");
    expect(detail?.artifact?.segments[0]?.text).toBe("Привет");
  });
});
