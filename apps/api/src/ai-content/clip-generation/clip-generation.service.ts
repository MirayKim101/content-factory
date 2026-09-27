import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CLIP_GENERATION_CONTRACT_VERSION,
  validateClipGenerationRequest,
} from "@content-factory/contracts";
import { Prisma } from "../../generated/prisma/client.js";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { CreateClipGenerationDto } from "./clip-generation.dto.js";

const PROMPT_VERSION = "openai-clip-selection-v1";

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
    if (!source.authorizations.length)
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
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          CLIP_GENERATION_CONTRACT_VERSION,
          projectId,
          source.id,
          source.sourceVersion,
          request,
          true,
        ]),
      )
      .digest("hex");
    const id = randomUUID();
    const environment = apiEnvironment();
    const inserted = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      INSERT INTO "ClipGenerationIntent" ("id","idempotencyKey","requestFingerprint","projectId","sourceId","sourceVersion","sourceTitle","sourceDurationMs","transcript","transcriptSha256","language","maximumSuggestions","minimumClipDurationMs","maximumClipDurationMs","externalTransferAllowed","provider","model","contractVersion","promptVersion","updatedAt")
      VALUES (${id}::uuid,${idempotencyKey},${fingerprint},${projectId}::uuid,${source.id}::uuid,${source.sourceVersion},${body.sourceTitle.trim()},${source.durationMs},${transcriptJson}::jsonb,${transcriptSha256},${body.language},${body.maximumSuggestions},${body.minimumClipDurationMs},${body.maximumClipDurationMs},TRUE,'OPENAI',${environment.clipGenerationModel!},${CLIP_GENERATION_CONTRACT_VERSION},${PROMPT_VERSION},now())
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
