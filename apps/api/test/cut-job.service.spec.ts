import type {
  CreateCutJobResult,
  CutJobRepository,
  CutJobView,
} from "@content-factory/manual-cut";
import { describe, expect, it, vi } from "vitest";

import { CutJobService } from "../src/cuts/cut-job.service.js";

describe("CutJobService enqueue boundary", () => {
  it("publishes only a newly persisted intent", async () => {
    const queue = { publish: vi.fn(async () => undefined) };
    const created = new CutJobService(
      repository(async () => ({ outcome: "CREATED", job: job() })),
      queue,
    );
    await created.create({
      projectId: PROJECT_ID,
      idempotencyKey: "cut-created-key",
      startMs: 0,
      endMs: 1_000,
    });
    expect(queue.publish).toHaveBeenCalledOnce();

    queue.publish.mockClear();
    const replay = new CutJobService(
      repository(async () => ({ outcome: "EXISTING", job: job() })),
      queue,
    );
    await replay.create({
      projectId: PROJECT_ID,
      idempotencyKey: "cut-created-key",
      startMs: 0,
      endMs: 1_000,
    });
    expect(queue.publish).not.toHaveBeenCalled();
  });
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function job(): CutJobView {
  const now = new Date("2026-09-09T00:00:00.000Z");
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: PROJECT_ID,
    sourceId: "33333333-3333-4333-8333-333333333333",
    sourceVersion: 1,
    sourceSha256: "a".repeat(64),
    startMs: 0,
    endMs: 1_000,
    recipeVersion: "horizontal-cut-v1",
    state: "QUEUED",
    stage: "QUEUED",
    progress: null,
    attempts: 0,
    queueReason: null,
    admissionDeadlineAt: new Date(now.getTime() + 900_000),
    failure: null,
    revision: 0,
    artifact: null,
    createdAt: now,
    updatedAt: now,
  };
}

function repository(
  create: (
    input: Parameters<CutJobRepository["create"]>[0],
  ) => Promise<CreateCutJobResult>,
): CutJobRepository {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    create,
    get: unused,
    list: unused,
    getAuthorizedSourceMedia: unused,
    getReadyDownload: unused,
    getAdmission: unused,
    claim: unused,
    heartbeat: unused,
    recordProgress: unused,
    persistOutputIntent: unused,
    complete: unused,
    fail: unused,
    markScratchWait: unused,
    failWithoutAttempt: unused,
    reconcileExpired: unused,
    findRunnable: unused,
    findPendingOutputCleanup: unused,
    findScratchCleanupAttemptIds: unused,
    completeOutputCleanup: unused,
    failOutputCleanup: unused,
  };
}
