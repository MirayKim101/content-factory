import { z } from "zod";
import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type FrameEvidence = components["schemas"]["FrameEvidenceDto"];
export type FrameRequest = components["schemas"]["CreateFrameEvidenceDto"];
export type FrameScope = Pick<
  FrameEvidence["identity"],
  "projectId" | "sourceId" | "sourceVersion" | "cutPipelineJobId"
>;
const uuid = z.uuid();
const integer = z.number().int().nonnegative();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const frameScopeSchema = z.object({
  projectId: uuid,
  sourceId: uuid,
  sourceVersion: integer.positive(),
  cutPipelineJobId: uuid,
});
export const frameRequestSchema: z.ZodType<FrameRequest> = z.object({
  sourceContextRevisionId: uuid,
  cutPromptRevisionId: uuid,
});
const measurement = z.object({
  ordinal: integer.max(2),
  requestedCutMs: integer,
  requestedSourceMs: integer,
  actualPtsTicks: integer,
  timeBaseNumerator: z.literal(1),
  timeBaseDenominator: z.literal(1_000_000),
  actualCutMs: z.number().nonnegative(),
  mappedSourceMs: z.number().nonnegative(),
  width: integer.min(1).max(640),
  height: integer.min(1).max(640),
  sizeBytes: integer.min(1).max(4 * 1024 * 1024),
  sha256: sha,
  contentType: z.literal("image/jpeg"),
  recipeVersion: z.literal("quartiles-jpeg-640-v1"),
  extractorVersion: z.literal("ffmpeg-frame-extractor-v1"),
  ffmpegVersion: z.string().min(1),
});
const evidenceSchema: z.ZodType<FrameEvidence> = z
  .object({
    id: uuid,
    pipelineJobId: uuid,
    identity: frameScopeSchema.extend({
      sourceSha256: sha,
      sourceAuthorizationRevision: integer.positive(),
      sourceAuthorizationBasis: z.string(),
      sourceAuthorizationDeclarationVersion: z.string(),
      sourceAuthorizationDecidedAt: z.iso.datetime(),
      cutResultArtifactId: uuid,
      cutResultSha256: sha,
      cutResultSizeBytes: z.string().regex(/^\d+$/),
      cutStartMs: integer,
      cutEndMs: integer,
      creatorProfileId: uuid,
      creatorProfileRevisionId: uuid,
      creatorProfileRevisionNo: integer.positive(),
      sourceContextId: uuid,
      sourceContextRevisionId: uuid,
      sourceContextRevisionNo: integer.positive(),
      cutPromptId: uuid,
      cutPromptRevisionId: uuid,
      cutPromptRevisionNo: integer.positive(),
    }),
    contractVersion: z.literal("editorial-sparse-frames-v1"),
    recipeVersion: z.literal("quartiles-jpeg-640-v1"),
    requestedPositionsMs: z.array(integer).length(3),
    createdAt: z.iso.datetime(),
    currentUse: z.object({
      usableForGeneration: z.boolean(),
      blockers: z.array(z.string()),
      contextPolicyFingerprint: z.string().nullable(),
    }),
    contentAccess: z.object({
      bytesReadable: z.boolean(),
      blocker: z.literal("SOURCE_AUTHORIZATION_REQUIRED").nullable(),
    }),
    job: z.object({
      state: z.enum([
        "QUEUED",
        "PROCESSING",
        "RETRY_WAIT",
        "READY",
        "FAILED_FINAL",
      ]),
      revision: integer.positive(),
      attempt: integer,
      nextAttemptAt: z.iso.datetime().nullable(),
      admissionReason: z.string().nullable(),
      failure: z.object({ code: z.string(), message: z.string() }).nullable(),
      progress: z
        .object({
          schemaVersion: z.literal("editorial-frame-progress-v1"),
          phase: z.enum([
            "READ_INPUT",
            "EXTRACT",
            "HASH",
            "UPLOAD",
            "FINALIZE",
          ]),
          completedFrameCount: integer.max(3),
          basisPoints: integer.max(10000),
        })
        .nullable(),
    }),
    frames: z.array(z.object({ id: uuid, measurement })).max(3),
  })
  .superRefine((value, ctx) => {
    if (
      value.job.state === "READY" &&
      (value.frames.length !== 3 ||
        value.frames.some(
          (frame, ordinal) => frame.measurement.ordinal !== ordinal,
        ))
    )
      ctx.addIssue({ code: "custom", message: "Неполный набор кадров." });
  });
const listSchema = z.object({
  items: z.array(evidenceSchema).max(50),
  nextCursor: z.string().nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export class FrameEvidenceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "FrameEvidenceApiError";
  }
}
export function frameActive(value: FrameEvidence): boolean {
  return ["QUEUED", "PROCESSING", "RETRY_WAIT"].includes(value.job.state);
}
function scoped(value: FrameEvidence, scope: FrameScope): FrameEvidence {
  if (
    Object.entries(scope).some(
      ([key, expected]) => value.identity[key as keyof FrameScope] !== expected,
    )
  )
    throw new FrameEvidenceApiError(
      "FRAME_SCOPE_MISMATCH",
      "Получены данные другой нарезки. Обновите страницу.",
    );
  return value;
}
export function createFrameEvidenceApi(
  baseInput: unknown,
  fetcher: typeof fetch = fetch,
) {
  const base = parseApiBasePath(baseInput);
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, init);
    } catch {
      throw new FrameEvidenceApiError(
        "NETWORK_ERROR",
        "Нет связи с сервером. Результат запроса пока неизвестен.",
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = errorSchema.safeParse(body);
      throw new FrameEvidenceApiError(
        error.success ? error.data.error.code : "API_RESPONSE_INVALID",
        error.success
          ? error.data.error.message
          : "Не удалось прочитать ответ сервера.",
        response.status,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new FrameEvidenceApiError(
        "API_RESPONSE_INVALID",
        "Ответ сервера не прошёл проверку. Обновите данные.",
        response.status,
      );
    return parsed.data;
  }
  return {
    async create(
      scope: FrameScope,
      body: FrameRequest,
      key: string,
    ): Promise<FrameEvidence> {
      const parsed = frameRequestSchema.parse(body);
      const value = scoped(
        await request(
          `/pipeline-jobs/${encodeURIComponent(scope.cutPipelineJobId)}/frame-evidence`,
          evidenceSchema,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify(parsed),
          },
        ),
        scope,
      );
      if (
        value.identity.sourceContextRevisionId !==
          parsed.sourceContextRevisionId ||
        value.identity.cutPromptRevisionId !== parsed.cutPromptRevisionId
      )
        throw new FrameEvidenceApiError(
          "FRAME_SCOPE_MISMATCH",
          "Ответ относится к другим версиям контекста.",
        );
      return value;
    },
    async get(id: string, scope: FrameScope): Promise<FrameEvidence> {
      const value = scoped(
        await request(
          `/frame-evidence/${encodeURIComponent(id)}`,
          evidenceSchema,
        ),
        scope,
      );
      if (value.id !== id)
        throw new FrameEvidenceApiError(
          "FRAME_SCOPE_MISMATCH",
          "Получен другой набор кадров.",
        );
      return value;
    },
    async list(scope: FrameScope, cursor?: string | null) {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const page = await request(
        `/pipeline-jobs/${encodeURIComponent(scope.cutPipelineJobId)}/frame-evidence?${params}`,
        listSchema,
      );
      page.items.forEach((item) => scoped(item, scope));
      return page;
    },
    contentUrl: (intentId: string, frameId: string) =>
      `${base}/frame-evidence/${encodeURIComponent(uuid.parse(intentId))}/frames/${encodeURIComponent(uuid.parse(frameId))}/content`,
  };
}
