import { createHash, randomUUID } from "node:crypto";
import {
  TRANSCRIPT_CONTRACT_VERSION,
  type TranscriptEvidenceView,
  type TranscriptInputCapture,
} from "@content-factory/contracts";
import {
  LocalManualTranscriptAdapter,
  type LocalTranscriptFixture,
} from "./local-transcript-adapter.js";
import {
  TranscriptIdempotencyConflictError,
  type TranscriptRepository,
} from "./transcript-repository.port.js";

/** Small deterministic repository used by local/manual acceptance and adapter tests. */
export class InMemoryTranscriptRepository implements TranscriptRepository {
  private readonly rows = new Map<string, TranscriptEvidenceView>();
  private readonly keys = new Map<
    string,
    { fingerprint: string; id: string }
  >();

  async create(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    language: string;
    input: TranscriptInputCapture;
  }): Promise<string> {
    const old = this.keys.get(input.idempotencyKey);
    if (old) {
      if (old.fingerprint !== input.requestFingerprint)
        throw new TranscriptIdempotencyConflictError();
      return old.id;
    }
    const id = randomUUID();
    this.keys.set(input.idempotencyKey, {
      fingerprint: input.requestFingerprint,
      id,
    });
    this.rows.set(id, {
      id,
      state: "QUEUED",
      contractVersion: TRANSCRIPT_CONTRACT_VERSION,
      adapterVersion: "local-manual-transcript-v1",
      language: input.language,
      input: input.input,
      artifact: null,
      failure: null,
    });
    return id;
  }

  async detail(id: string): Promise<TranscriptEvidenceView | null> {
    return this.rows.get(id) ?? null;
  }

  async complete(input: {
    id: string;
    artifact: TranscriptEvidenceView["artifact"];
  }): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row) throw new Error("TRANSCRIPT_NOT_FOUND");
    if (!input.artifact) throw new Error("TRANSCRIPT_ARTIFACT_REQUIRED");
    this.rows.set(input.id, {
      ...row,
      state: "READY",
      artifact: input.artifact,
    });
  }

  async fail(input: {
    id: string;
    code: string;
    message: string;
  }): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row) throw new Error("TRANSCRIPT_NOT_FOUND");
    this.rows.set(input.id, {
      ...row,
      state: "FAILED_FINAL",
      failure: { code: input.code, message: input.message },
    });
  }
}

export class LocalTranscriptService {
  constructor(
    private readonly repository: TranscriptRepository,
    private readonly adapter = new LocalManualTranscriptAdapter(),
  ) {}

  async create(input: {
    idempotencyKey: string;
    language: string;
    context: TranscriptInputCapture;
  }): Promise<string> {
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({ language: input.language, context: input.context }),
      )
      .digest("hex");
    return this.repository.create({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      language: input.language,
      input: input.context,
    });
  }

  async deliver(input: {
    id: string;
    fixture: LocalTranscriptFixture;
  }): Promise<void> {
    const row = await this.repository.detail(input.id);
    if (!row) throw new Error("TRANSCRIPT_NOT_FOUND");
    if (row.state === "READY") return;
    const artifact = this.adapter.transcribe({
      fixture: input.fixture,
      durationMs: row.input.cutEndMs - row.input.cutStartMs,
      artifactId: randomUUID(),
    });
    await this.repository.complete({ id: input.id, artifact });
  }
}
