import { z } from "zod";
import {
  PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS,
  PUBLIC_CITATION_PUBLISHER_MAX_LENGTH,
  PUBLIC_CITATION_TITLE_MAX_LENGTH,
  PUBLIC_COMPONENT_INCOMPLETE_REASONS,
} from "@content-factory/contracts";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type EditorialReview =
  components["schemas"]["EditorialReviewResponseDto"];
export type EditorialApproval =
  components["schemas"]["EditorialApprovalResponseDto"];
export type CreateEditorialApproval =
  components["schemas"]["CreateEditorialApprovalDto"];

const uuid = z.uuid();
const metricIncompleteReasonSchema = z.enum(
  PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS,
);
const componentIncompleteReasonSchema = z.enum(
  PUBLIC_COMPONENT_INCOMPLETE_REASONS,
);
const jobMetricsSchema = z
  .object({
    initialQueueWaitMs: z.number().int().nullable(),
    retryWaitMs: z.number().int().nullable(),
    firstStartToFinishMs: z.number().int().nullable(),
    activeAttemptMs: z.number().int().nullable(),
    attemptCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
  })
  .strict();
export const processingMetricsSchema = z
  .object({
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
    incompleteReasons: z.array(metricIncompleteReasonSchema),
  })
  .strict();
const citationSchema = z
  .object({
    id: uuid,
    url: z.url().startsWith("https://"),
    title: z.string().min(1).max(PUBLIC_CITATION_TITLE_MAX_LENGTH),
    publisher: z.string().min(1).max(PUBLIC_CITATION_PUBLISHER_MAX_LENGTH),
    publishedAt: z.iso.datetime().nullable(),
    accessedAt: z.iso.datetime(),
  })
  .strict();
export const noLikenessSafetyDecisionSchema = z
  .object({
    version: z.literal("no-likeness-safety-v1"),
    realisticPersonRequested: z.literal(false),
    referenceImageUsed: z.literal(false),
    externalProviderUsed: z.literal(false),
  })
  .strict();
export const componentSummarySchema = z
  .object({
    component: z.enum(["METADATA", "THUMBNAIL"]),
    provenanceId: uuid.nullable(),
    mode: z.enum(["MANUAL", "AI_ASSISTED", "MIXED"]),
    basisVersion: z.string(),
    researchIntentId: uuid.nullable(),
    suggestionSetId: uuid.nullable(),
    imageIntentId: uuid.nullable(),
    imageCandidateId: uuid.nullable(),
    transcriptArtifactId: uuid.nullable(),
    transcriptSha256: z.string().nullable(),
    citations: z.array(citationSchema).max(20),
    research: z
      .object({
        searchedAt: z.iso.datetime(),
        freshUntil: z.iso.datetime(),
        freshness: z.enum(["CURRENT", "EXPIRED"]),
      })
      .nullable(),
    imageSafetyDecision: noLikenessSafetyDecisionSchema.nullable(),
    likeness: z.literal("NONE").nullable(),
    directCostMicrousd: z.string().regex(/^\d+$/),
    costBasisVersion: z.string(),
    incompleteReasons: z.array(componentIncompleteReasonSchema),
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const editorialApprovalEconomicsV2Schema = z
  .object({
    schemaVersion: z.literal("approval-economics-v2"),
    workflowMode: z.enum(["MANUAL", "AI_ASSISTED", "MIXED"]),
    attention: z
      .object({
        schemaVersion: z.literal("operator-attention-v2"),
        preparationForegroundMs: z.number().int().nonnegative(),
        finalReviewForegroundMs: z.number().int().nonnegative(),
        totalOperatorAttentionMs: z.number().int().nonnegative(),
      })
      .strict(),
    metadataDirectCostMicrousd: z.string().regex(/^\d+$/),
    evidenceDirectCostMicrousd: z.string().regex(/^\d+$/),
    thumbnailDirectCostMicrousd: z.string().regex(/^\d+$/),
    combinedDirectCostMicrousd: z.string().regex(/^\d+$/),
    currency: z.literal("USD"),
    unit: z.literal("MICRO"),
    metadataCostBasisVersion: z.string().min(1),
    evidenceCostBasisVersion: z.string().min(1),
    thumbnailCostBasisVersion: z.string().min(1),
    assistanceTiming: z.null(),
    incompleteReasons: z.array(z.never()).max(0),
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.attention.totalOperatorAttentionMs !==
      value.attention.preparationForegroundMs +
        value.attention.finalReviewForegroundMs
    )
      context.addIssue({
        code: "custom",
        path: ["attention", "totalOperatorAttentionMs"],
        message: "attention total does not match its split",
      });
    const total =
      BigInt(value.metadataDirectCostMicrousd) +
      BigInt(value.evidenceDirectCostMicrousd) +
      BigInt(value.thumbnailDirectCostMicrousd);
    if (total.toString() !== value.combinedDirectCostMicrousd)
      context.addIssue({
        code: "custom",
        path: ["combinedDirectCostMicrousd"],
        message: "cost total does not match its breakdown",
      });
  });
export const editorialApprovalResponseSchema: z.ZodType<EditorialApproval> =
  z.object({
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
    approvalContractVersion: z.enum([
      "manual-horizontal-approval-v1",
      "human-horizontal-approval-v2",
    ]),
    fingerprintBasisVersion: z
      .enum([
        "editorial-approval-fingerprint-v2-date-object-legacy",
        "editorial-approval-fingerprint-v2-iso8601",
      ])
      .nullable(),
    candidateFingerprint: z.string(),
    approvedAt: z.iso.datetime(),
    state: z.enum(["CURRENT", "STALE"]),
    staleReasons: z.array(z.string()),
    metrics: processingMetricsSchema.extend({
      manualAttentionMs: z.number().int().nonnegative(),
      attentionMeasurementVersion: z.enum([
        "foreground-preview-v1",
        "operator-attention-v2",
      ]),
    }),
    componentSnapshots: z.array(componentSummarySchema),
    economicsV2: editorialApprovalEconomicsV2Schema.nullable(),
  });
const reviewSchema: z.ZodType<EditorialReview> = z.object({
  reviewContractVersion: z.literal("editorial-review-candidate-v2"),
  integratedReviewEnabled: z.boolean(),
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
  workflowMode: z.enum(["MANUAL", "AI_ASSISTED", "MIXED"]),
  components: z.object({
    metadata: componentSummarySchema,
    thumbnail: componentSummarySchema,
  }),
  economicsPreview: z.object({
    processingMetrics: processingMetricsSchema.nullable(),
    metadataDirectCostMicrousd: z.string().regex(/^\d+$/),
    evidenceDirectCostMicrousd: z.string().regex(/^\d+$/),
    thumbnailDirectCostMicrousd: z.string().regex(/^\d+$/),
    combinedDirectCostMicrousd: z.string().regex(/^\d+$/),
    currency: z.literal("USD"),
    unit: z.literal("MICRO"),
    incompleteReasons: z.array(z.string()),
  }),
  currentApproval: editorialApprovalResponseSchema.nullable(),
  latestApproval: editorialApprovalResponseSchema.nullable(),
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
        editorialApprovalResponseSchema,
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
