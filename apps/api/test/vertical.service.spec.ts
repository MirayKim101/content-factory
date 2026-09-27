import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VerticalService,
  VerticalUnavailableError,
} from "../src/vertical/vertical.service.js";

function fixture() {
  const job = { id: "00000000-0000-4000-8000-000000000020" };
  const tx = {
    verticalRenderIntent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "intent-1",
        job,
        result: null,
      })),
    },
    pipelineJob: {
      findUnique: vi.fn(async () => ({
        id: "00000000-0000-4000-8000-000000000010",
        projectId: "00000000-0000-4000-8000-000000000001",
        sourceId: "00000000-0000-4000-8000-000000000002",
        sourceVersion: 1,
        type: "CUT_SEGMENT",
        state: "READY",
        source: {
          id: "00000000-0000-4000-8000-000000000002",
          projectId: "00000000-0000-4000-8000-000000000001",
          sourceVersion: 1,
          authorizations: [{ sourceVersion: 1, status: "CLEARED" }],
        },
        resultArtifact: {
          id: "00000000-0000-4000-8000-000000000003",
          status: "READY",
          role: "CUT_RESULT",
          projectId: "00000000-0000-4000-8000-000000000001",
          lineageSourceId: "00000000-0000-4000-8000-000000000002",
          lineageSourceVersion: 1,
          pipelineJobId: "00000000-0000-4000-8000-000000000010",
        },
      })),
      create: vi.fn(async () => undefined),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const dispatch = { dispatch: vi.fn(async () => undefined) };
  return { tx, prisma, dispatch };
}

describe("VerticalService", () => {
  const original = process.env.VERTICAL_RENDER_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.VERTICAL_RENDER_ENABLED;
    else process.env.VERTICAL_RENDER_ENABLED = original;
  });

  it("fails closed before persistence", async () => {
    process.env.VERTICAL_RENDER_ENABLED = "0";
    const { prisma, dispatch } = fixture();
    await expect(
      new VerticalService(prisma as never, dispatch).create({
        projectId: "00000000-0000-4000-8000-000000000001",
        cutPipelineJobId: "00000000-0000-4000-8000-000000000010",
        idempotencyKey: "vertical-test-1",
      }),
    ).rejects.toBeInstanceOf(VerticalUnavailableError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it("captures exact cut lineage and dispatches only the durable job id", async () => {
    process.env.VERTICAL_RENDER_ENABLED = "1";
    const { tx, prisma, dispatch } = fixture();
    await new VerticalService(prisma as never, dispatch).create({
      projectId: "00000000-0000-4000-8000-000000000001",
      cutPipelineJobId: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "vertical-test-1",
    });
    expect(tx.verticalRenderIntent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cutResultArtifactId: "00000000-0000-4000-8000-000000000003",
        outputWidth: 1080,
        outputHeight: 1920,
        renderContractVersion: "vertical-render-v1",
      }),
    });
    expect(dispatch.dispatch).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
    );
  });
});
