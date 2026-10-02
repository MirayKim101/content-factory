import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CLIP_GENERATION_CONTRACT_VERSION,
  CLIP_GENERATION_PROMPT_VERSIONS,
  validateClipGenerationRequest,
} from "@content-factory/contracts";
import { Prisma } from "../../generated/prisma/client.js";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { CreateClipGenerationDto } from "./clip-generation.dto.js";

@Injectable()
export class ClipGenerationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    projectId: string,
    idempotencyKey: string,
    body: CreateClipGenerationDto,
  ) {
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
      include: {
        authorizations: {
          where: { status: "CLEARED" },
          orderBy: { revision: "desc" },
          take: 1,
        },
      },
    });
    if (!source || source.status !== "READY" || !source.durationMs)
      throw new NotFoundException({ code: "CLIP_GENERATION_SOURCE_NOT_READY" });
    if (
      !source.authorizations.length ||
      source.authorizations[0]?.basis === "LOCAL_DEVELOPMENT_AUTO"
    )
      throw new ConflictException({
        code: "CLIP_GENERATION_RIGHTS_NOT_CLEARED",
      });
    if (!body.externalProviderTransferAllowed)
      throw new ConflictException({
        code: "CLIP_GENERATION_EXTERNAL_TRANSFER_REQUIRED",
      });
    const request = {
      sourceDurationMs: source.durationMs,
      sourceTitle: body.sourceTitle,
      transcript: body.transcript,
      maximumSuggestions: body.maximumSuggestions,
      minimumClipDurationMs: body.minimumClipDurationMs,
      maximumClipDurationMs: body.maximumClipDurationMs,
      language: body.language,
    };
    validateClipGenerationRequest(request);
    const transcriptJson = JSON.stringify(body.transcript);
    const transcriptSha256 = createHash("sha256")
      .update(transcriptJson)
      .digest("hex");
    const environment = apiEnvironment();
    const promptVersion =
      CLIP_GENERATION_PROMPT_VERSIONS[environment.clipGenerationProvider];
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          CLIP_GENERATION_CONTRACT_VERSION,
          projectId,
          source.id,
          source.sourceVersion,
          environment.clipGenerationProvider,
          environment.clipGenerationModel,
          promptVersion,
          request,
          true,
        ]),
      )
      .digest("hex");
    const id = randomUUID();
    const inserted = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      INSERT INTO "ClipGenerationIntent" ("id","idempotencyKey","requestFingerprint","projectId","sourceId","sourceVersion","sourceTitle","sourceDurationMs","transcript","transcriptSha256","language","maximumSuggestions","minimumClipDurationMs","maximumClipDurationMs","externalTransferAllowed","provider","model","contractVersion","promptVersion","updatedAt")
      VALUES (${id}::uuid,${idempotencyKey},${fingerprint},${projectId}::uuid,${source.id}::uuid,${source.sourceVersion},${body.sourceTitle.trim()},${source.durationMs},${transcriptJson}::jsonb,${transcriptSha256},${body.language},${body.maximumSuggestions},${body.minimumClipDurationMs},${body.maximumClipDurationMs},TRUE,${environment.clipGenerationProvider},${environment.clipGenerationModel!},${CLIP_GENERATION_CONTRACT_VERSION},${promptVersion},now())
      ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING "id"`);
    const resolvedId =
      inserted[0]?.id ?? (await this.idForKey(idempotencyKey, fingerprint));
    return this.detail(resolvedId);
  }

  async detail(id: string) {
    const rows = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >(Prisma.sql`
      SELECT i."id", i."projectId", i."state"::text, i."provider", i."model", i."failureCode", i."failureMessage", i."createdAt", i."updatedAt",
        COALESCE(jsonb_agg(jsonb_build_object('id',s."id",'ordinal',s."ordinal",'startMs',s."startMs",'endMs',s."endMs",'title',s."title",'rationale',s."rationale",'confidenceBasisPoints',s."confidenceBasisPoints") ORDER BY s."ordinal") FILTER (WHERE s."id" IS NOT NULL),'[]'::jsonb) AS "suggestions"
      FROM "ClipGenerationIntent" i LEFT JOIN "ClipGenerationSuggestion" s ON s."intentId"=i."id"
      WHERE i."id"=${id}::uuid GROUP BY i."id"`);
    if (!rows[0])
      throw new NotFoundException({ code: "CLIP_GENERATION_NOT_FOUND" });
    return rows[0];
  }

  async list(projectId: string) {
    return this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT i."id", i."projectId", i."state"::text, i."provider", i."model", i."failureCode", i."failureMessage", i."createdAt", i."updatedAt",
        COALESCE(jsonb_agg(jsonb_build_object('id',s."id",'ordinal',s."ordinal",'startMs',s."startMs",'endMs',s."endMs",'title',s."title",'rationale',s."rationale",'confidenceBasisPoints',s."confidenceBasisPoints") ORDER BY s."ordinal") FILTER (WHERE s."id" IS NOT NULL),'[]'::jsonb) AS "suggestions"
      FROM "ClipGenerationIntent" i LEFT JOIN "ClipGenerationSuggestion" s ON s."intentId"=i."id"
      WHERE i."projectId"=${projectId}::uuid GROUP BY i."id"
      ORDER BY i."createdAt" DESC, i."id" DESC LIMIT 20`);
  }

  async resolveAcceptance(intentId: string, suggestionIds: readonly string[]) {
    if (
      suggestionIds.length < 1 ||
      suggestionIds.length > 20 ||
      new Set(suggestionIds).size !== suggestionIds.length
    )
      throw new ConflictException({
        code: "CLIP_GENERATION_SUGGESTION_SELECTION_INVALID",
      });
    const rows = await this.prisma.$queryRaw<
      Array<{
        projectId: string;
        sourceId: string;
        sourceVersion: number;
        sourceDurationMs: number;
        suggestionId: string;
        startMs: number;
        endMs: number;
      }>
    >(Prisma.sql`
      SELECT i."projectId", i."sourceId", i."sourceVersion", i."sourceDurationMs",
             s."id" AS "suggestionId", s."startMs", s."endMs"
        FROM "ClipGenerationIntent" i
        JOIN "VideoSource" v ON v."id"=i."sourceId" AND v."projectId"=i."projectId" AND v."sourceVersion"=i."sourceVersion"
        JOIN "Project" p ON p."id"=i."projectId"
        JOIN "SourceAuthorization" a ON a."sourceId"=v."id" AND a."sourceVersion"=v."sourceVersion"
        JOIN "ClipGenerationSuggestion" s ON s."intentId"=i."id"
       WHERE i."id"=${intentId}::uuid AND i."state"='READY'
         AND v."status"='READY' AND p."status"='SOURCE_READY'
         AND v."durationMs"=i."sourceDurationMs" AND a."status"='CLEARED'
         AND a."basis" IS NOT NULL AND a."basis" <> 'LOCAL_DEVELOPMENT_AUTO'
         AND s."id" IN (${Prisma.join(suggestionIds.map((id) => Prisma.sql`${id}::uuid`))})
       ORDER BY s."ordinal"`);
    if (rows.length !== suggestionIds.length)
      throw new ConflictException({ code: "CLIP_GENERATION_ACCEPTANCE_STALE" });
    const first = rows[0]!;
    return {
      projectId: first.projectId,
      segments: rows.map((row) => ({
        clientSegmentId: row.suggestionId,
        startMs: row.startMs,
        endMs: row.endMs,
      })),
    };
  }

  async recordAcceptance(input: {
    intentId: string;
    cutRequestId: string;
    idempotencyKey: string;
    suggestionIds: readonly string[];
  }): Promise<void> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.intentId, input.suggestionIds]))
      .digest("hex");
    const ids = JSON.stringify(input.suggestionIds);
    const inserted = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ClipGenerationAcceptance" ("id","intentId","cutRequestId","idempotencyKey","requestFingerprint","suggestionIds")
      VALUES (${randomUUID()}::uuid,${input.intentId}::uuid,${input.cutRequestId}::uuid,${input.idempotencyKey},${fingerprint},${ids}::jsonb)
      ON CONFLICT ("idempotencyKey") DO NOTHING`);
    if (inserted === 0) {
      const rows = await this.prisma.$queryRaw<
        Array<{ cutRequestId: string; requestFingerprint: string }>
      >(Prisma.sql`
        SELECT "cutRequestId","requestFingerprint" FROM "ClipGenerationAcceptance" WHERE "idempotencyKey"=${input.idempotencyKey}`);
      if (
        !rows[0] ||
        rows[0].cutRequestId !== input.cutRequestId ||
        rows[0].requestFingerprint !== fingerprint
      )
        throw new ConflictException({
          code: "CLIP_GENERATION_ACCEPTANCE_IDEMPOTENCY_CONFLICT",
        });
    }
  }

  private async idForKey(key: string, fingerprint: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; requestFingerprint: string }>
    >(
      Prisma.sql`SELECT "id","requestFingerprint" FROM "ClipGenerationIntent" WHERE "idempotencyKey"=${key}`,
    );
    if (!rows[0] || rows[0].requestFingerprint !== fingerprint)
      throw new ConflictException({
        code: "CLIP_GENERATION_IDEMPOTENCY_CONFLICT",
      });
    return rows[0].id;
  }
}
