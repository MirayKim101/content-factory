import { Injectable } from "@nestjs/common";

import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { PublicationRepository } from "../application/publication-repository.port.js";
import {
  PublicationChannelConflictError,
  PublicationCancellationConflictError,
  PublicationCursorInvalidError,
  PublicationIdempotencyConflictError,
  PublicationLineageInvalidError,
  PublicationRetryConflictError,
  type PublicationIntentView,
} from "../domain/publication.js";

const intentInclude = {
  result: true,
} satisfies Prisma.PublicationIntentInclude;

type IntentRow = Prisma.PublicationIntentGetPayload<{
  include: typeof intentInclude;
}>;

@Injectable()
export class PrismaPublicationRepository implements PublicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createChannel(
    input: Parameters<PublicationRepository["createChannel"]>[0],
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) throw new PublicationLineageInvalidError();
    const existing = await this.prisma.publicationChannel.findUnique({
      where: {
        projectId_platform_externalChannelRef: {
          projectId: input.projectId,
          platform: input.platform,
          externalChannelRef: input.externalChannelRef,
        },
      },
    });
    if (existing) {
      if (
        existing.displayName !== input.displayName ||
        existing.timezone !== input.timezone
      )
        throw new PublicationChannelConflictError();
      return existing;
    }
    try {
      return await this.prisma.publicationChannel.create({ data: input });
    } catch (error) {
      if (this.isRetryable(error)) {
        const replay = await this.prisma.publicationChannel.findUnique({
          where: {
            projectId_platform_externalChannelRef: {
              projectId: input.projectId,
              platform: input.platform,
              externalChannelRef: input.externalChannelRef,
            },
          },
        });
        if (
          replay &&
          replay.displayName === input.displayName &&
          replay.timezone === input.timezone
        )
          return replay;
        throw new PublicationChannelConflictError();
      }
      throw error;
    }
  }

  listChannels(projectId: string) {
    return this.prisma.publicationChannel.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async get(id: string): Promise<PublicationIntentView | null> {
    const row = await this.prisma.publicationIntent.findUnique({
      where: { id },
      include: intentInclude,
    });
    if (!row) return null;
    return (await this.mapWithLatestMetrics([row]))[0] ?? null;
  }

  async listProject(input: {
    projectId: string;
    channelId?: string;
    cursor?: string;
    limit: number;
  }): Promise<PublicationIntentView[]> {
    const channel = input.channelId
      ? await this.prisma.publicationChannel.findFirst({
          where: { id: input.channelId, projectId: input.projectId },
          select: { id: true },
        })
      : null;
    if (input.channelId && !channel) throw new PublicationCursorInvalidError();
    const anchor = input.cursor
      ? await this.prisma.publicationIntent.findFirst({
          where: {
            id: input.cursor,
            projectId: input.projectId,
            ...(input.channelId ? { channelId: input.channelId } : {}),
          },
          select: { id: true, scheduledAt: true },
        })
      : null;
    if (input.cursor && !anchor) throw new PublicationCursorInvalidError();
    const rows = await this.prisma.publicationIntent.findMany({
      where: {
        projectId: input.projectId,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(anchor
          ? {
              OR: [
                { scheduledAt: { lt: anchor.scheduledAt } },
                {
                  scheduledAt: anchor.scheduledAt,
                  id: { lt: anchor.id },
                },
              ],
            }
          : {}),
      },
      include: intentInclude,
      orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return this.mapWithLatestMetrics(rows);
  }

  async cancel(id: string, now: Date): Promise<PublicationIntentView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.publicationIntent.findUnique({
        where: { id },
        include: intentInclude,
      });
      if (!row) throw new PublicationLineageInvalidError();
      if (row.state === "CANCELED") return this.map(row);
      if (row.state !== "SCHEDULED" && row.state !== "QUEUED")
        throw new PublicationCancellationConflictError();
      const updated = await tx.publicationIntent.updateMany({
        where: { id, state: { in: ["SCHEDULED", "QUEUED"] } },
        data: { state: "CANCELED", canceledAt: now, finishedAt: now },
      });
      if (updated.count !== 1) throw new PublicationCancellationConflictError();
      const canceled = await tx.publicationIntent.findUnique({
        where: { id },
        include: intentInclude,
      });
      if (!canceled) throw new PublicationLineageInvalidError();
      return this.map(canceled);
    });
  }

  async retry(id: string, now: Date): Promise<PublicationIntentView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.publicationIntent.findUnique({
        where: { id },
        include: { result: true, providerSession: true, channel: true },
      });
      if (!row) throw new PublicationLineageInvalidError();
      if (
        row.state !== "FAILED_FINAL" ||
        row.remotePublicationId !== null ||
        row.result !== null ||
        row.providerSession !== null ||
        row.channel.state !== "ENABLED"
      )
        throw new PublicationRetryConflictError();
      const updated = await tx.publicationIntent.updateMany({
        where: {
          id,
          state: "FAILED_FINAL",
          remotePublicationId: null,
          result: { is: null },
          providerSession: { is: null },
        },
        data: {
          state: "QUEUED",
          scheduledAt: now,
          attemptCount: 0,
          remoteStatus: null,
          reconciliationLeaseToken: null,
          reconciliationLeaseExpiresAt: null,
          metricsLeaseToken: null,
          metricsLeaseExpiresAt: null,
          failureCode: null,
          failureMessage: null,
          queuedAt: now,
          startedAt: null,
          finishedAt: null,
        },
      });
      if (updated.count !== 1) throw new PublicationRetryConflictError();
      const retried = await tx.publicationIntent.findUnique({
        where: { id },
        include: intentInclude,
      });
      if (!retried) throw new PublicationLineageInvalidError();
      return this.map(retried);
    });
  }

  create(input: Parameters<PublicationRepository["create"]>[0]) {
    return this.createWithRetry(input, 0);
  }

  private async createWithRetry(
    input: Parameters<PublicationRepository["create"]>[0],
    conflictCount: number,
  ): Promise<PublicationIntentView> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.publicationIntent.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: intentInclude,
          });
          if (replay) return this.requireReplay(replay, input);

          const channel = await tx.publicationChannel.findUnique({
            where: { id: input.channelId },
          });
          if (
            !channel ||
            channel.projectId !== input.projectId ||
            channel.platform !== input.platform ||
            channel.state !== "ENABLED" ||
            channel.timezone !== input.timezone
          )
            throw new PublicationLineageInvalidError();

          let exportIntentId: string | undefined;
          if (input.contentKind === "EDITORIAL_EXPORT") {
            if (
              !input.approvalId ||
              !input.exportResultId ||
              input.verticalApprovalId ||
              input.verticalResultId
            )
              throw new PublicationLineageInvalidError();
            const exportResult = await tx.editorialExportResult.findUnique({
              where: { id: input.exportResultId },
              include: {
                artifact: true,
                pipelineJob: true,
                exportIntent: {
                  include: {
                    approval: {
                      include: {
                        source: true,
                        editorialPackage: true,
                        assemblyRecipe: true,
                      },
                    },
                  },
                },
              },
            });
            if (!exportResult) throw new PublicationLineageInvalidError();
            const exportIntent = exportResult.exportIntent;
            const approval = exportIntent.approval;
            if (
              exportIntent.projectId !== input.projectId ||
              exportIntent.approvalId !== input.approvalId ||
              approval.projectId !== input.projectId ||
              approval.source.sourceVersion !== approval.sourceVersion ||
              approval.editorialPackage.currentRevision !==
                approval.editorialRevision ||
              approval.assemblyRecipe.currentRevision !==
                approval.recipeRevision ||
              exportResult.pipelineJob.state !== "READY" ||
              exportResult.pipelineJob.editorialExportIntentId !==
                exportIntent.id ||
              exportResult.pipelineJobId !==
                exportResult.artifact.pipelineJobId ||
              exportResult.artifact.status !== "READY" ||
              exportResult.artifact.role !== "EDITORIAL_EXPORT_PACKAGE" ||
              exportResult.artifact.projectId !== input.projectId ||
              exportResult.archiveSha256 !== exportResult.artifact.sha256 ||
              exportResult.archiveSizeBytes !== exportResult.artifact.sizeBytes
            )
              throw new PublicationLineageInvalidError();
            exportIntentId = exportIntent.id;
          } else {
            if (
              !input.verticalApprovalId ||
              !input.verticalResultId ||
              input.approvalId ||
              input.exportResultId
            )
              throw new PublicationLineageInvalidError();
            const vertical = await tx.verticalRenderResult.findUnique({
              where: { id: input.verticalResultId },
              include: {
                approval: true,
                artifact: true,
                pipelineJob: true,
                intent: true,
              },
            });
            if (
              !vertical ||
              vertical.approval?.id !== input.verticalApprovalId ||
              vertical.intent.projectId !== input.projectId ||
              vertical.pipelineJob.state !== "READY" ||
              vertical.pipelineJob.verticalRenderIntentId !==
                vertical.intentId ||
              vertical.artifact.projectId !== input.projectId ||
              vertical.artifact.pipelineJobId !== vertical.pipelineJobId ||
              vertical.artifact.status !== "READY" ||
              vertical.artifact.role !== "VERTICAL_RENDER_RESULT" ||
              vertical.sha256 !== vertical.artifact.sha256 ||
              vertical.sizeBytes !== vertical.artifact.sizeBytes
            )
              throw new PublicationLineageInvalidError();
          }

          const row = await tx.publicationIntent.create({
            data: {
              id: input.id,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: input.requestFingerprint,
              projectId: input.projectId,
              channelId: input.channelId,
              contentKind: input.contentKind,
              approvalId: input.approvalId,
              exportIntentId,
              exportResultId: input.exportResultId,
              verticalApprovalId: input.verticalApprovalId,
              verticalResultId: input.verticalResultId,
              platform: input.platform,
              scheduledAt: input.scheduledAt,
              timezone: input.timezone,
              metadataSnapshot:
                input.metadataSnapshot as Prisma.InputJsonObject,
            },
            include: intentInclude,
          });
          return this.map(row);
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        error instanceof PublicationIdempotencyConflictError ||
        error instanceof PublicationLineageInvalidError
      )
        throw error;
      if (this.isRetryable(error) && conflictCount < 5) {
        await new Promise((resolve) =>
          setTimeout(resolve, 5 * 2 ** conflictCount),
        );
        return this.createWithRetry(input, conflictCount + 1);
      }
      const replay = await this.prisma.publicationIntent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: intentInclude,
      });
      if (replay) return this.requireReplay(replay, input);
      if (this.isRetryable(error))
        throw new PublicationIdempotencyConflictError();
      throw error;
    }
  }

  private requireReplay(
    row: IntentRow,
    input: Parameters<PublicationRepository["create"]>[0],
  ): PublicationIntentView {
    if (
      row.requestFingerprint !== input.requestFingerprint ||
      row.projectId !== input.projectId ||
      row.channelId !== input.channelId ||
      row.contentKind !== input.contentKind ||
      row.approvalId !== (input.approvalId ?? null) ||
      row.exportResultId !== (input.exportResultId ?? null) ||
      row.verticalApprovalId !== (input.verticalApprovalId ?? null) ||
      row.verticalResultId !== (input.verticalResultId ?? null) ||
      row.platform !== input.platform
    )
      throw new PublicationIdempotencyConflictError();
    return this.map(row);
  }

  private map(row: IntentRow): PublicationIntentView {
    const metadata = row.metadataSnapshot;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new PublicationLineageInvalidError();
    return {
      id: row.id,
      projectId: row.projectId,
      channelId: row.channelId,
      contentKind: row.contentKind,
      approvalId: row.approvalId,
      exportIntentId: row.exportIntentId,
      exportResultId: row.exportResultId,
      verticalApprovalId: row.verticalApprovalId,
      verticalResultId: row.verticalResultId,
      platform: row.platform,
      scheduledAt: row.scheduledAt,
      timezone: row.timezone,
      metadataSnapshot: metadata as Record<string, unknown>,
      state: row.state,
      attemptCount: row.attemptCount,
      retryBudget: row.retryBudget,
      remotePublicationId: row.remotePublicationId,
      remoteStatus: row.remoteStatus,
      failure:
        row.failureCode && row.failureMessage
          ? { code: row.failureCode, message: row.failureMessage }
          : null,
      latestMetrics: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async mapWithLatestMetrics(
    rows: IntentRow[],
  ): Promise<PublicationIntentView[]> {
    if (!rows.length) return [];
    const snapshots = await this.prisma.$queryRaw<
      Array<{
        publicationIntentId: string;
        viewCount: bigint;
        likeCount: bigint | null;
        commentCount: bigint | null;
        shareCount: bigint | null;
        observedAt: Date;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON ("publicationIntentId")
        "publicationIntentId", "viewCount", "likeCount", "commentCount",
        "shareCount", "observedAt"
      FROM "PublicationMetricSnapshot"
      WHERE "publicationIntentId" IN (${Prisma.join(rows.map((row) => row.id))})
      ORDER BY "publicationIntentId", "observedAt" DESC
    `);
    const byIntent = new Map(
      snapshots.map((snapshot) => [snapshot.publicationIntentId, snapshot]),
    );
    return rows.map((row) => {
      const value = this.map(row);
      const snapshot = byIntent.get(row.id);
      if (!snapshot) return value;
      return {
        ...value,
        latestMetrics: {
          viewCount: snapshot.viewCount.toString(),
          likeCount: snapshot.likeCount?.toString() ?? null,
          commentCount: snapshot.commentCount?.toString() ?? null,
          shareCount: snapshot.shareCount?.toString() ?? null,
          observedAt: snapshot.observedAt,
        },
      };
    });
  }

  private isRetryable(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "P2002" || code === "P2034";
  }
}
