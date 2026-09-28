import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VerticalLineageInvalidError,
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
          status: "READY",
          authorizations: [{ sourceVersion: 1, status: "CLEARED" }],
        },
        resultArtifact: {
          id: "00000000-0000-4000-8000-000000000003",
          status: "READY",
          role: "CUT_RESULT",
          contentType: "video/mp4",
          projectId: "00000000-0000-4000-8000-000000000001",
          lineageSourceId: "00000000-0000-4000-8000-000000000002",
          lineageSourceVersion: 1,
          pipelineJobId: "00000000-0000-4000-8000-000000000010",
        },
      })),
      create: vi.fn(async () => undefined),
    },
    verticalApproval: {
      create: vi.fn(async (input: { data: Record<string, unknown> }) => ({
        ...input.data,
        createdAt: new Date("2026-09-28T00:00:00.000Z"),
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    ),
    verticalApproval: { findFirst: vi.fn(async () => null) },
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

  it("reports effective render admission without exposing configuration", () => {
    process.env.VERTICAL_RENDER_ENABLED = "0";
    const { prisma, dispatch } = fixture();
    const service = new VerticalService(prisma as never, dispatch);
    expect(service.capabilities()).toEqual({ renderEnabled: false });
    process.env.VERTICAL_RENDER_ENABLED = "1";
    expect(service.capabilities()).toEqual({ renderEnabled: true });
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

  it("rejects a render when the source is no longer ready", async () => {
    process.env.VERTICAL_RENDER_ENABLED = "1";
    const { tx, prisma, dispatch } = fixture();
    const cut = await tx.pipelineJob.findUnique();
    tx.pipelineJob.findUnique.mockResolvedValueOnce({
      ...cut,
      source: { ...cut!.source, status: "FAILED_FINAL" },
    });

    await expect(
      new VerticalService(prisma as never, dispatch).create({
        projectId: "00000000-0000-4000-8000-000000000001",
        cutPipelineJobId: "00000000-0000-4000-8000-000000000010",
        idempotencyKey: "vertical-stale-source",
      }),
    ).rejects.toBeInstanceOf(VerticalLineageInvalidError);
    expect(tx.verticalRenderIntent.create).not.toHaveBeenCalled();
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it("rejects approval after the source lineage becomes stale", async () => {
    process.env.VERTICAL_RENDER_ENABLED = "1";
    const { tx, prisma, dispatch } = fixture();
    tx.verticalRenderIntent.findUnique.mockResolvedValueOnce(
      approvalRecord({ currentSourceVersion: 2 }) as never,
    );

    await expect(
      new VerticalService(prisma as never, dispatch).approve("intent-1"),
    ).rejects.toBeInstanceOf(VerticalLineageInvalidError);
    expect(tx.verticalApproval.create).not.toHaveBeenCalled();
  });

  it("creates one approval for an exact current vertical result", async () => {
    process.env.VERTICAL_RENDER_ENABLED = "1";
    const { tx, prisma, dispatch } = fixture();
    tx.verticalRenderIntent.findUnique.mockResolvedValueOnce(
      approvalRecord() as never,
    );

    await expect(
      new VerticalService(prisma as never, dispatch).approve("intent-1"),
    ).resolves.toMatchObject({
      resultId: "result-1",
      approvalVersion: "human-vertical-approval-v1",
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(tx.verticalApproval.create).toHaveBeenCalledOnce();
  });
});

function approvalRecord(
  options: { currentSourceVersion?: number } = {},
) {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const sourceId = "00000000-0000-4000-8000-000000000002";
  const cutJobId = "00000000-0000-4000-8000-000000000010";
  const renderJobId = "00000000-0000-4000-8000-000000000020";
  return {
    id: "intent-1",
    projectId,
    sourceId,
    sourceVersion: 1,
    cutPipelineJobId: cutJobId,
    renderContractVersion: "vertical-render-v1",
    source: {
      sourceVersion: options.currentSourceVersion ?? 1,
      status: "READY",
      authorizations: [{ sourceVersion: 1, status: "CLEARED" }],
    },
    cutPipelineJob: { type: "CUT_SEGMENT", state: "READY" },
    cutResultArtifact: {
      status: "READY",
      role: "CUT_RESULT",
      contentType: "video/mp4",
      pipelineJobId: cutJobId,
      projectId,
      lineageSourceId: sourceId,
      lineageSourceVersion: 1,
    },
    job: {
      id: renderJobId,
      state: "READY",
      verticalRenderIntentId: "intent-1",
    },
    result: {
      id: "result-1",
      pipelineJobId: renderJobId,
      renderContractVersion: "vertical-render-v1",
      width: 1080,
      height: 1920,
      sha256: "a".repeat(64),
      sizeBytes: 1024n,
      approval: null,
      artifact: {
        status: "READY",
        role: "VERTICAL_RENDER_RESULT",
        contentType: "video/mp4",
        pipelineJobId: renderJobId,
        projectId,
        lineageSourceId: sourceId,
        lineageSourceVersion: 1,
        sha256: "a".repeat(64),
        sizeBytes: 1024n,
      },
    },
  };
}
