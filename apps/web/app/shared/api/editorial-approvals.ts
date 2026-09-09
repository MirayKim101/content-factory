import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type EditorialReview =
  components["schemas"]["EditorialReviewResponseDto"];
export type EditorialApproval =
  components["schemas"]["EditorialApprovalResponseDto"];
export type CreateEditorialApproval =
  components["schemas"]["CreateEditorialApprovalDto"];

const uuid = z.uuid();
const jobMetricsSchema = z.object({
  initialQueueWaitMs: z.number().int().nullable(),
  retryWaitMs: z.number().int().nullable(),
  firstStartToFinishMs: z.number().int().nullable(),
  activeAttemptMs: z.number().int().nullable(),
  attemptCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
});
const processingMetricsSchema = z.object({
  metricsSchemaVersion: z.literal("approval-metrics-v1"),
  timestampBasisVersion: z.literal("persisted-job-attempt-v1"),
  cut: jobMetricsSchema,
  assembly: jobMetricsSchema,
  cutToAssemblyReadyElapsedMs: z.number().int().nullable(),
  outputDurationMs: z.number().int().positive(),
  outputBytes: z.string().regex(/^\d+$/),
  directProviderCostMinor: z.literal(0),
  costCurrency: z.literal("RUB"),
  costBasisVersion: z.literal("local-direct-provider-cost-v1"),
  incompleteReasons: z.array(z.string()),
});
const approvalSchema: z.ZodType<EditorialApproval> = z.object({
  id: uuid,
  projectId: uuid,
  sourceId: uuid,
  sourceVersion: z.number().int().positive(),
  cutPipelineJobId: uuid,
  editorialPackageId: uuid,
  editorialPackageRevisionId: uuid,
  editorialRevision: z.number().int().positive(),
  processingTemplateRevisionId: uuid,
  thumbnailAssetId: uuid,
  thumbnailSha256: z.string(),
  thumbnailSizeBytes: z.string().regex(/^\d+$/),
  thumbnailContentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  assemblyRecipeId: uuid,
  recipeRevisionId: uuid,
  recipeRevision: z.number().int().positive(),
  configurationFingerprint: z.string(),
  assemblyRenderIntentId: uuid,
  assemblyRenderResultId: uuid,
  renderArtifactId: uuid,
  renderArtifactSha256: z.string(),
  renderArtifactSizeBytes: z.string().regex(/^\d+$/),
  renderContractVersion: z.literal("horizontal-render-v1"),
  approvalContractVersion: z.literal("manual-horizontal-approval-v1"),
  candidateFingerprint: z.string(),
  approvedAt: z.iso.datetime(),
  state: z.enum(["CURRENT", "STALE"]),
  staleReasons: z.array(z.string()),
  metrics: processingMetricsSchema.extend({
    manualAttentionMs: z.number().int().nonnegative(),
    attentionMeasurementVersion: z.literal("foreground-preview-v1"),
  }),
});
const reviewSchema: z.ZodType<EditorialReview> = z.object({
  projectId: uuid,
  sourceId: uuid,
  sourceVersion: z.number().int().positive(),
  cutPipelineJobId: uuid,
  cutResultArtifactId: uuid.nullable(),
  approvable: z.boolean(),
  blockers: z.array(z.string()),
  candidateFingerprint: z.string().nullable(),
  editorial: z
    .object({
      packageId: uuid,
      revisionId: uuid,
      revision: z.number().int().positive(),
      processingTemplateRevisionId: uuid,
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      thumbnail: z.object({
        id: uuid,
        filename: z.string(),
        contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        sha256: z.string(),
        sizeBytes: z.string().regex(/^\d+$/),
        contentUrl: z.string(),
      }),
    })
    .nullable(),
  recipe: z
    .object({
      id: uuid,
      revisionId: uuid,
      revision: z.number().int().positive(),
      configurationFingerprint: z.string(),
    })
    .nullable(),
  render: z
    .object({
      id: uuid,
      resultId: uuid,
      artifactId: uuid,
      artifactSha256: z.string(),
      artifactSizeBytes: z.string().regex(/^\d+$/),
      renderContractVersion: z.literal("horizontal-render-v1"),
      durationMs: z.number().int().positive(),
      contentUrl: z.string(),
    })
    .nullable(),
  processingMetrics: processingMetricsSchema.nullable(),
  currentApproval: approvalSchema.nullable(),
  latestApproval: approvalSchema.nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class EditorialApprovalApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EditorialApprovalApiError";
  }
}

export function createEditorialApprovalsApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    review(cutJobId: string): Promise<EditorialReview> {
      return request(
        fetchImplementation,
        `${basePath}/pipeline-jobs/${encodeURIComponent(cutJobId)}/editorial-review`,
        {},
        reviewSchema,
      );
    },
    approve(
      renderId: string,
      body: CreateEditorialApproval,
      idempotencyKey: string,
    ): Promise<EditorialApproval> {
      return request(
        fetchImplementation,
        `${basePath}/assembly-renders/${encodeURIComponent(renderId)}/editorial-approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        approvalSchema,
      );
    },
  };
}

async function request<T>(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new EditorialApprovalApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API. Повторите запрос с тем же ключом.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new EditorialApprovalApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
