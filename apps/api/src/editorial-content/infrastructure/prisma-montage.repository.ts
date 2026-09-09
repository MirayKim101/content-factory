import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service.js";
import { sourceAuthorizationRuntime } from "../../config/environment.js";
import type { MontageRepository } from "../application/montage-repository.port.js";
import {
  MONTAGE_RIGHTS_DECLARATION,
  MontageError,
  montageRightsUsable,
  type MontageKind,
} from "../domain/montage-asset.js";

type Client = Pick<
  PrismaService,
  "videoSource" | "montageAsset" | "pipelineJob"
>;

@Injectable()
export class PrismaMontageRepository implements MontageRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async authorize(projectId: string, client: Client = this.prisma) {
    const source = await client.videoSource.findUnique({
      where: { projectId },
      include: { authorizations: true },
    });
    if (!source || source.status !== "READY")
      throw new MontageError(
        "SOURCE_NOT_READY",
        "A ready source project is required.",
        409,
      );
    const auth = source.authorizations.find(
      (a) => a.sourceVersion === source.sourceVersion,
    );
    const policy = sourceAuthorizationRuntime().policy;
    if (
      !auth ||
      auth.status !== "CLEARED" ||
      !auth.basis ||
      !auth.declarationVersion ||
      !auth.decidedAt ||
      (auth.basis === "LOCAL_DEVELOPMENT_AUTO" && policy !== "local-auto")
    )
      throw new MontageError(
        "SOURCE_AUTHORIZATION_REQUIRED",
        "Source authorization is required.",
        403,
      );
    if (policy !== "local-auto")
      throw new MontageError(
        "MONTAGE_RIGHTS_REQUIRED",
        "Separate montage rights evidence is required. This slice supports the explicit local development policy only.",
        403,
      );
    return { sourceId: source.id, sourceVersion: source.sourceVersion };
  }

  async findReplay(projectId: string, key: string) {
    const context = await this.authorize(projectId);
    const row = await this.prisma.montageAsset.findUnique({
      where: { idempotencyKey: key },
      include: { probeJob: true },
    });
    if (!row) return null;
    if (row.projectId !== projectId)
      throw new MontageError(
        "IDEMPOTENCY_CONFLICT",
        "Key belongs to another upload.",
        409,
      );
    this.checkContext(row, context);
    return row;
  }

  async create(input: Parameters<MontageRepository["create"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        const context = await this.authorize(input.projectId, tx);
        if (
          context.sourceId !== input.sourceId ||
          context.sourceVersion !== input.sourceVersion
        )
          throw new MontageError(
            "SOURCE_VERSION_STALE",
            "Source version changed.",
            409,
          );
        return tx.montageAsset.create({
          data: {
            ...input,
            rightsBasis: "LOCAL_DEVELOPMENT_AUTO",
            rightsDeclaration: MONTAGE_RIGHTS_DECLARATION,
            rightsDecidedAt: new Date(),
          },
          include: { probeJob: true },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

  async finalize(id: string, receipt: { etag?: string; version?: string }) {
    return this.prisma.$transaction(
      async (tx) => {
        const asset = await tx.montageAsset.findUniqueOrThrow({
          where: { id },
          include: { probeJob: true },
        });
        this.checkContext(asset, await this.authorize(asset.projectId, tx));
        if (asset.status !== "UPLOADING") return asset;
        const changed = await tx.montageAsset.updateMany({
          where: { id, status: "UPLOADING", cleanupStatus: "NOT_REQUIRED" },
          data: {
            status: asset.kind === "BANNER" ? "READY" : "PROBE_PENDING",
            revision: { increment: 1 },
            storageEtag: receipt.etag,
            storageVersion: receipt.version,
          },
        });
        if (changed.count !== 1)
          throw new MontageError(
            "MONTAGE_STATE_CONFLICT",
            "Upload state changed.",
            409,
          );
        if (asset.kind !== "BANNER")
          await tx.pipelineJob.create({
            data: {
              id: randomUUID(),
              projectId: asset.projectId,
              sourceId: asset.sourceId,
              sourceVersion: asset.sourceVersion,
              montageAssetId: id,
              type: "MONTAGE_ASSET_PROBE",
              payloadVersion: 1,
              recipeVersion: "montage-asset-probe-v1",
              idempotencyKey: `montage-probe:v1:${id}:${asset.sha256}`,
              retryBudget: 2,
            },
          });
        return tx.montageAsset.findUniqueOrThrow({
          where: { id },
          include: { probeJob: true },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

  async inspect(id: string) {
    return this.prisma.montageAsset.findUnique({
      where: { id },
      include: { probeJob: true },
    });
  }

  async get(projectId: string, id: string) {
    const context = await this.authorize(projectId);
    const row = await this.prisma.montageAsset.findFirst({
      where: { id, projectId },
      include: { probeJob: true },
    });
    if (row) this.checkContext(row, context);
    return row;
  }

  async list(
    projectId: string,
    kind: MontageKind | undefined,
    cursor: string | undefined,
    limit: number,
  ) {
    const context = await this.authorize(projectId);
    const anchor = cursor
      ? await this.prisma.montageAsset.findFirst({
          where: { id: cursor, projectId, ...context },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !anchor)
      throw new MontageError(
        "MONTAGE_CURSOR_INVALID",
        "Cursor does not belong to this project.",
        400,
      );
    const rows = await this.prisma.montageAsset.findMany({
      where: {
        projectId,
        ...context,
        ...(kind ? { kind } : {}),
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      include: { probeJob: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    for (const row of rows) this.checkContext(row, context);
    return rows;
  }

  async recoverable(limit: number) {
    return this.prisma.montageAsset.findMany({
      where: {
        OR: [
          { status: "UPLOADING", uploadExpiresAt: { lt: new Date() } },
          { status: "FAILED_FINAL", cleanupStatus: "PENDING" },
        ],
      },
      include: { probeJob: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  }

  async failUpload(id: string, code: string) {
    const result = await this.prisma.montageAsset.updateMany({
      where: { id, status: "UPLOADING", uploadExpiresAt: { lt: new Date() } },
      data: {
        status: "FAILED_FINAL",
        revision: { increment: 1 },
        failureCode: code,
        failureMessage: "Upload could not be recovered.",
        cleanupStatus: "PENDING",
      },
    });
    return result.count === 1;
  }
  async completeCleanup(id: string) {
    await this.prisma.montageAsset.updateMany({
      where: { id, status: "FAILED_FINAL", cleanupStatus: "PENDING" },
      data: {
        cleanupStatus: "COMPLETED",
        cleanupCompletedAt: new Date(),
        cleanupLastErrorCode: null,
      },
    });
  }
  async cleanupFailed(id: string) {
    await this.prisma.montageAsset.updateMany({
      where: { id, cleanupStatus: "PENDING" },
      data: {
        cleanupAttemptCount: { increment: 1 },
        cleanupLastErrorCode: "OBJECT_DELETE_FAILED",
      },
    });
  }

  private checkContext(
    row: {
      sourceId: string;
      sourceVersion: number;
      rightsBasis: string;
      rightsDeclaration: string;
      rightsDecidedAt: Date;
    },
    context: { sourceId: string; sourceVersion: number },
  ) {
    if (
      row.sourceId !== context.sourceId ||
      row.sourceVersion !== context.sourceVersion
    )
      throw new MontageError(
        "SOURCE_VERSION_STALE",
        "Montage resource belongs to an earlier source version.",
        403,
      );
    if (!montageRightsUsable(row, sourceAuthorizationRuntime().policy))
      throw new MontageError(
        "MONTAGE_RIGHTS_REQUIRED",
        "Montage asset rights evidence is not usable.",
        403,
      );
  }
}
