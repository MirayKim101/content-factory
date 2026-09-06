export const EDITORIAL_APPROVAL_CONTRACT =
  "manual-horizontal-approval-v1" as const;
export const APPROVAL_METRICS_SCHEMA = "approval-metrics-v1" as const;
export const APPROVAL_TIMESTAMP_BASIS = "persisted-job-attempt-v1" as const;
export const ATTENTION_MEASUREMENT_VERSION = "foreground-preview-v1" as const;
export const APPROVAL_COST_BASIS = "local-direct-provider-cost-v1" as const;

export type EditorialApprovalState = "CURRENT" | "STALE";

export type EditorialApprovalBlocker =
  | "CUT_NOT_READY"
  | "EDITORIAL_PACKAGE_MISSING"
  | "EDITORIAL_PACKAGE_INCOMPLETE"
  | "EDITORIAL_PROFILE_UNSUPPORTED"
  | "THUMBNAIL_NOT_READY"
  | "ASSEMBLY_RECIPE_MISSING"
  | "ASSEMBLY_PROFILE_UNSUPPORTED"
  | "ASSEMBLY_RENDER_NOT_READY"
  | "LINEAGE_INVALID"
  | "AUTHORIZATION_REQUIRED"
  | "ASSET_RIGHTS_REQUIRED"
  | "APPROVAL_CONTRACT_UNSUPPORTED"
  | "RENDER_CONTRACT_UNSUPPORTED"
  | "PROCESSING_METRICS_INCOMPLETE";

export type EditorialApprovalStaleReason =
  | "EDITORIAL_REVISION_CHANGED"
  | "ASSEMBLY_RECIPE_REVISION_CHANGED"
  | "RENDER_RESULT_NOT_READY"
  | "THUMBNAIL_NOT_READY"
  | "AUTHORIZATION_REQUIRED"
  | "ASSET_RIGHTS_REQUIRED"
  | "APPROVAL_CONTRACT_UNSUPPORTED"
  | "RENDER_CONTRACT_UNSUPPORTED"
  | "LINEAGE_INVALID";

export type ApprovalMetricIncompleteReason =
  | "CUT_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING"
  | "CUT_INITIAL_QUEUE_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED"
  | "CUT_RETRY_WAIT_TIMESTAMP_MISSING"
  | "CUT_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED"
  | "CUT_ACTIVE_ATTEMPT_TIMESTAMP_MISSING"
  | "CUT_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID"
  | "CUT_FIRST_START_TO_FINISH_TIMESTAMP_MISSING"
  | "CUT_FIRST_START_TO_FINISH_TIMESTAMP_ORDER_INVALID"
  | "ASSEMBLY_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING"
  | "ASSEMBLY_INITIAL_QUEUE_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED"
  | "ASSEMBLY_RETRY_WAIT_TIMESTAMP_MISSING"
  | "ASSEMBLY_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED"
  | "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_MISSING"
  | "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID"
  | "ASSEMBLY_FIRST_START_TO_FINISH_TIMESTAMP_MISSING"
  | "ASSEMBLY_FIRST_START_TO_FINISH_TIMESTAMP_ORDER_INVALID"
  | "CUT_TO_ASSEMBLY_READY_TIMESTAMP_MISSING"
  | "CUT_TO_ASSEMBLY_READY_TIMESTAMP_ORDER_INVALID";

export interface PersistedAttemptTimestamp {
  attemptNumber: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface PersistedJobTimestamp {
  queuedAt: Date;
  finishedAt: Date | null;
  attempts: PersistedAttemptTimestamp[];
}

export interface ApprovalJobMetrics {
  initialQueueWaitMs: number | null;
  retryWaitMs: number | null;
  firstStartToFinishMs: number | null;
  activeAttemptMs: number | null;
  attemptCount: number;
  retryCount: number;
}

export interface ApprovalProcessingMetrics {
  metricsSchemaVersion: typeof APPROVAL_METRICS_SCHEMA;
  timestampBasisVersion: typeof APPROVAL_TIMESTAMP_BASIS;
  cut: ApprovalJobMetrics;
  assembly: ApprovalJobMetrics;
  cutToAssemblyReadyElapsedMs: number | null;
  outputDurationMs: number;
  outputBytes: bigint;
  directProviderCostMinor: number;
  costCurrency: "RUB";
  costBasisVersion: typeof APPROVAL_COST_BASIS;
  incompleteReasons: ApprovalMetricIncompleteReason[];
}

export interface EditorialApprovalMetrics extends ApprovalProcessingMetrics {
  manualAttentionMs: number;
  attentionMeasurementVersion: typeof ATTENTION_MEASUREMENT_VERSION;
}

export interface EditorialApprovalView {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  editorialPackageId: string;
  editorialPackageRevisionId: string;
  editorialRevision: number;
  processingTemplateRevisionId: string;
  thumbnailAssetId: string;
  thumbnailSha256: string;
  thumbnailSizeBytes: bigint;
  thumbnailContentType: string;
  assemblyRecipeId: string;
  recipeRevisionId: string;
  recipeRevision: number;
  configurationFingerprint: string;
  assemblyRenderIntentId: string;
  assemblyRenderResultId: string;
  renderArtifactId: string;
  renderArtifactSha256: string;
  renderArtifactSizeBytes: bigint;
  renderContractVersion: string;
  approvalContractVersion: typeof EDITORIAL_APPROVAL_CONTRACT;
  candidateFingerprint: string;
  approvedAt: Date;
  state: EditorialApprovalState;
  staleReasons: EditorialApprovalStaleReason[];
  metrics: EditorialApprovalMetrics;
}

export interface EditorialReviewView {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  cutResultArtifactId: string | null;
  editorial: {
    packageId: string;
    revisionId: string;
    revision: number;
    processingTemplateRevisionId: string;
    title: string;
    description: string;
    tags: string[];
    thumbnail: {
      id: string;
      sha256: string;
      sizeBytes: bigint;
      contentType: string;
      filename: string;
      contentUrl: string;
    };
  } | null;
  recipe: {
    id: string;
    revisionId: string;
    revision: number;
    configurationFingerprint: string;
  } | null;
  render: {
    id: string;
    resultId: string;
    artifactId: string;
    artifactSha256: string;
    artifactSizeBytes: bigint;
    renderContractVersion: string;
    durationMs: number;
    contentUrl: string;
  } | null;
  candidateFingerprint: string | null;
  approvable: boolean;
  blockers: EditorialApprovalBlocker[];
  processingMetrics: ApprovalProcessingMetrics | null;
  currentApproval: EditorialApprovalView | null;
  latestApproval: EditorialApprovalView | null;
}

export class EditorialReviewNotFoundError extends Error {}
export class EditorialApprovalNotFoundError extends Error {}
export class EditorialApprovalCursorInvalidError extends Error {}
export class EditorialApprovalIdempotencyConflictError extends Error {}
export class EditorialApprovalCandidateConflictError extends Error {}
export class EditorialApprovalAuthorizationError extends Error {}
export class EditorialApprovalLineageInvalidError extends Error {}
export class EditorialApprovalUnavailableError extends Error {}

const metricPrefix = (scope: "CUT" | "ASSEMBLY") => scope;

export function calculateApprovalProcessingMetrics(input: {
  cut: PersistedJobTimestamp;
  assembly: PersistedJobTimestamp;
  outputDurationMs: number;
  outputBytes: bigint;
}): ApprovalProcessingMetrics {
  const incompleteReasons: ApprovalMetricIncompleteReason[] = [];
  const cut = calculateJobMetrics("CUT", input.cut, incompleteReasons);
  const assembly = calculateJobMetrics(
    "ASSEMBLY",
    input.assembly,
    incompleteReasons,
  );
  const cutToAssemblyReadyElapsedMs = difference(
    input.cut.queuedAt,
    input.assembly.finishedAt,
    "CUT_TO_ASSEMBLY_READY_TIMESTAMP_MISSING",
    "CUT_TO_ASSEMBLY_READY_TIMESTAMP_ORDER_INVALID",
    incompleteReasons,
  );
  return {
    metricsSchemaVersion: APPROVAL_METRICS_SCHEMA,
    timestampBasisVersion: APPROVAL_TIMESTAMP_BASIS,
    cut,
    assembly,
    cutToAssemblyReadyElapsedMs,
    outputDurationMs: input.outputDurationMs,
    outputBytes: input.outputBytes,
    directProviderCostMinor: 0,
    costCurrency: "RUB",
    costBasisVersion: APPROVAL_COST_BASIS,
    incompleteReasons,
  };
}

function calculateJobMetrics(
  scope: "CUT" | "ASSEMBLY",
  job: PersistedJobTimestamp,
  reasons: ApprovalMetricIncompleteReason[],
): ApprovalJobMetrics {
  const attempts = [...job.attempts].sort(
    (left, right) => left.attemptNumber - right.attemptNumber,
  );
  const started = attempts.filter(
    (attempt): attempt is PersistedAttemptTimestamp & { startedAt: Date } =>
      attempt.startedAt !== null,
  );
  const firstStartedAt = started.reduce<Date | null>(
    (minimum, attempt) =>
      minimum === null || attempt.startedAt.getTime() < minimum.getTime()
        ? attempt.startedAt
        : minimum,
    null,
  );
  const initialQueueWaitMs = difference(
    job.queuedAt,
    firstStartedAt,
    `${metricPrefix(scope)}_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING`,
    `${metricPrefix(scope)}_INITIAL_QUEUE_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED`,
    reasons,
  );
  const firstStartToFinishMs = difference(
    firstStartedAt,
    job.finishedAt,
    `${metricPrefix(scope)}_FIRST_START_TO_FINISH_TIMESTAMP_MISSING`,
    `${metricPrefix(scope)}_FIRST_START_TO_FINISH_TIMESTAMP_ORDER_INVALID`,
    reasons,
  );

  let retryWaitMs: number | null = 0;
  for (let index = 1; index < started.length; index += 1) {
    const previous = started[index - 1]!;
    const current = started[index]!;
    if (!previous.finishedAt) {
      retryWaitMs = null;
      addReason(reasons, `${metricPrefix(scope)}_RETRY_WAIT_TIMESTAMP_MISSING`);
      break;
    }
    const gap = current.startedAt.getTime() - previous.finishedAt.getTime();
    if (gap < 0) {
      retryWaitMs = null;
      addReason(
        reasons,
        `${metricPrefix(scope)}_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED`,
      );
      break;
    }
    retryWaitMs += gap;
  }

  let activeAttemptMs: number | null = 0;
  for (const attempt of started) {
    if (!attempt.finishedAt) {
      activeAttemptMs = null;
      addReason(
        reasons,
        `${metricPrefix(scope)}_ACTIVE_ATTEMPT_TIMESTAMP_MISSING`,
      );
      break;
    }
    const duration = attempt.finishedAt.getTime() - attempt.startedAt.getTime();
    if (duration < 0) {
      activeAttemptMs = null;
      addReason(
        reasons,
        `${metricPrefix(scope)}_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID`,
      );
      break;
    }
    activeAttemptMs += duration;
  }

  return {
    initialQueueWaitMs,
    retryWaitMs,
    firstStartToFinishMs,
    activeAttemptMs,
    attemptCount: started.length,
    retryCount: Math.max(started.length - 1, 0),
  };
}

function difference(
  start: Date | null,
  finish: Date | null,
  missingReason: ApprovalMetricIncompleteReason,
  invalidReason: ApprovalMetricIncompleteReason,
  reasons: ApprovalMetricIncompleteReason[],
): number | null {
  if (!start || !finish) {
    addReason(reasons, missingReason);
    return null;
  }
  const value = finish.getTime() - start.getTime();
  if (value < 0) {
    addReason(reasons, invalidReason);
    return null;
  }
  return value;
}

function addReason(
  reasons: ApprovalMetricIncompleteReason[],
  reason: ApprovalMetricIncompleteReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
