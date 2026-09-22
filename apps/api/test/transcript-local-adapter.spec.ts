import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TranscriptInputCapture } from "@content-factory/contracts";
import {
  InMemoryTranscriptRepository,
  LocalTranscriptService,
} from "../src/ai-content/transcript/local-transcript-service.js";
import { LocalManualTranscriptAdapter } from "../src/ai-content/transcript/local-transcript-adapter.js";
import { TranscriptIdempotencyConflictError } from "../src/ai-content/transcript/transcript-repository.port.js";

const input: TranscriptInputCapture = {
  projectId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceVersion: 1,
  sourceSha256: "a".repeat(64),
  sourceAuthorizationRevision: 1,
  cutPipelineJobId: "33333333-3333-4333-8333-333333333333",
  cutResultArtifactId: "44444444-4444-4444-8444-444444444444",
  cutResultSha256: "b".repeat(64),
  cutResultSizeBytes: "1048576",
  cutStartMs: 10_000,
  cutEndMs: 20_000,
  creatorProfileRevisionId: "55555555-5555-4555-8555-555555555555",
  creatorProfileRevisionNo: 2,
  sourceContextRevisionId: "66666666-6666-4666-8666-666666666666",
  sourceContextRevisionNo: 3,
  cutPromptRevisionId: "77777777-7777-4777-8777-777777777777",
  cutPromptRevisionNo: 1,
};

const fixture = {
  language: "ru",
  segments: [
    { ordinal: 0, startMs: 0, endMs: 1_200, text: " Начало записи " },
    { ordinal: 1, startMs: 1_200, endMs: 4_500, text: "Важная мысль" },
    { ordinal: 2, startMs: 4_500, endMs: 9_000, text: "Финал" },
  ],
} as const;

describe("Stage 2B-3 local transcript evidence slice", () => {
  it("creates one durable intent, replays by key and rejects a different request", async () => {
    const repository = new InMemoryTranscriptRepository();
    const service = new LocalTranscriptService(repository);
    const first = await service.create({
      idempotencyKey: "transcript-acceptance-1",
      language: "ru",
      context: input,
    });
    const replay = await service.create({
      idempotencyKey: "transcript-acceptance-1",
      language: "ru",
      context: input,
    });
    expect(replay).toBe(first);
    await expect(
      service.create({
        idempotencyKey: "transcript-acceptance-1",
        language: "en",
        context: input,
      }),
    ).rejects.toBeInstanceOf(TranscriptIdempotencyConflictError);
    expect((await repository.detail(first))?.state).toBe("QUEUED");
  });

  it("delivers async local fixture with ordered segments and exact private checksum", async () => {
    const repository = new InMemoryTranscriptRepository();
    const service = new LocalTranscriptService(repository);
    const id = await service.create({
      idempotencyKey: "transcript-acceptance-2",
      language: "ru",
      context: input,
    });
    await service.deliver({ id, fixture });
    const detail = await repository.detail(id);
    expect(detail?.state).toBe("READY");
    expect(
      detail?.artifact?.segments.map((segment) => segment.ordinal),
    ).toEqual([0, 1, 2]);
    expect(detail?.artifact?.segments[0]?.text).toBe("Начало записи");
    expect(detail?.artifact?.contentType).toBe("application/json");
    expect(detail?.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const adapter = new LocalManualTranscriptAdapter();
    const bytes = adapter.serialize(detail!.artifact!);
    expect(bytes.byteLength).toBe(detail!.artifact!.sizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      detail!.artifact!.sha256,
    );
    await service.deliver({ id, fixture });
    expect((await repository.detail(id))?.artifact?.id).toBe(
      detail?.artifact?.id,
    );
  });

  it.each([
    [
      "overlap",
      [
        { ordinal: 0, startMs: 0, endMs: 100, text: "a" },
        { ordinal: 1, startMs: 50, endMs: 200, text: "b" },
      ],
    ],
    ["outside-cut", [{ ordinal: 0, startMs: 0, endMs: 10_001, text: "a" }]],
    ["wrong-order", [{ ordinal: 1, startMs: 0, endMs: 100, text: "a" }]],
  ] as const)(
    "fails closed for malformed fixture: %s",
    async (_name, segments) => {
      const adapter = new LocalManualTranscriptAdapter();
      expect(() =>
        adapter.transcribe({
          fixture: { language: "ru", segments },
          durationMs: 10_000,
          artifactId: "88888888-8888-4888-8888-888888888888",
        }),
      ).toThrow(/TRANSCRIPT_SEGMENTS_INVALID/);
    },
  );
});
