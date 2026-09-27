import { Injectable } from "@nestjs/common";

import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { PublicationRepository } from "../application/publication-repository.port.js";
import {
  PublicationIdempotencyConflictError,
  PublicationLineageInvalidError,
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
            exportResult.pipelineJobId !== exportResult.artifact.pipelineJobId ||
            exportResult.artifact.status !== "READY" ||
            exportResult.artifact.role !== "EDITORIAL_EXPORT_PACKAGE" ||
            exportResult.artifact.projectId !== input.projectId ||
            exportResult.archiveSha256 !== exportResult.artifact.sha256 ||
            exportResult.archiveSizeBytes !== exportResult.artifact.sizeBytes
          )
            throw new PublicationLineageInvalidError();

          const row = await tx.publicationIntent.create({
            data: {
              id: input.id,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: input.requestFingerprint,
              projectId: input.projectId,
              channelId: input.channelId,
              approvalId: input.approvalId,
              exportIntentId: exportIntent.id,
              exportResultId: exportResult.id,
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
      row.approvalId !== input.approvalId ||
      row.exportResultId !== input.exportResultId ||
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
      approvalId: row.approvalId,
      exportIntentId: row.exportIntentId,
      exportResultId: row.exportResultId,
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private isRetryable(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "P2002" || code === "P2034";
  }
}
