export const PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS = [
  "CUT_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING",
  "CUT_INITIAL_QUEUE_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
  "CUT_RETRY_WAIT_TIMESTAMP_MISSING",
  "CUT_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
  "CUT_ACTIVE_ATTEMPT_TIMESTAMP_MISSING",
  "CUT_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID",
  "CUT_FIRST_START_TO_FINISH_TIMESTAMP_MISSING",
  "CUT_FIRST_START_TO_FINISH_TIMESTAMP_ORDER_INVALID",
  "ASSEMBLY_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING",
  "ASSEMBLY_INITIAL_QUEUE_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
  "ASSEMBLY_RETRY_WAIT_TIMESTAMP_MISSING",
  "ASSEMBLY_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
  "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_MISSING",
  "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID",
  "ASSEMBLY_FIRST_START_TO_FINISH_TIMESTAMP_MISSING",
  "ASSEMBLY_FIRST_START_TO_FINISH_TIMESTAMP_ORDER_INVALID",
  "CUT_TO_ASSEMBLY_READY_TIMESTAMP_MISSING",
  "CUT_TO_ASSEMBLY_READY_TIMESTAMP_ORDER_INVALID",
] as const;
export const LEGACY_APPROVAL_FINGERPRINT_BASIS =
  "editorial-approval-fingerprint-v2-date-object-legacy" as const;
export const ISO8601_APPROVAL_FINGERPRINT_BASIS =
  "editorial-approval-fingerprint-v2-iso8601" as const;

const ECONOMICS_KEYS = [
  "assistanceTiming",
  "attentionSchemaVersion",
  "combinedDirectCostMicrousd",
  "currency",
  "evidenceCostBasisVersion",
  "evidenceDirectCostMicrousd",
  "finalReviewForegroundMs",
  "incompleteReasons",
  "metadataCostBasisVersion",
  "metadataDirectCostMicrousd",
  "preparationForegroundMs",
  "schemaVersion",
  "snapshotFingerprint",
  "thumbnailCostBasisVersion",
  "thumbnailDirectCostMicrousd",
  "totalOperatorAttentionMs",
  "unit",
  "workflowMode",
] as const;
const METRICS_KEYS = [
  "assembly",
  "attentionMeasurementVersion",
  "costBasisVersion",
  "costCurrency",
  "cut",
  "cutToAssemblyReadyElapsedMs",
  "directProviderCostMinor",
  "incompleteReasons",
  "manualAttentionMs",
  "metricsSchemaVersion",
  "outputBytes",
  "outputDurationMs",
  "timestampBasisVersion",
] as const;
const JOB_METRIC_KEYS = [
  "activeAttemptMs",
  "attemptCount",
  "firstStartToFinishMs",
  "initialQueueWaitMs",
  "retryCount",
  "retryWaitMs",
] as const;

export type PublicApprovalEconomicsV2 = Readonly<{
  schemaVersion: "approval-economics-v2";
  workflowMode: "MANUAL" | "AI_ASSISTED" | "MIXED";
  attentionSchemaVersion: "operator-attention-v2";
  preparationForegroundMs: number;
  finalReviewForegroundMs: number;
  totalOperatorAttentionMs: number;
  metadataDirectCostMicrousd: string;
  evidenceDirectCostMicrousd: string;
  thumbnailDirectCostMicrousd: string;
  combinedDirectCostMicrousd: string;
  currency: "USD";
  unit: "MICRO";
  metadataCostBasisVersion: string;
  evidenceCostBasisVersion: string;
  thumbnailCostBasisVersion: string;
  assistanceTiming: null;
  incompleteReasons: readonly [];
  snapshotFingerprint: string;
}>;

export type PublicApprovalProcessingMetrics = Readonly<{
  metricsSchemaVersion: "approval-metrics-v1";
  timestampBasisVersion: "persisted-job-attempt-v1";
  cut: PublicApprovalJobMetrics;
  assembly: PublicApprovalJobMetrics;
  cutToAssemblyReadyElapsedMs: number | null;
  outputDurationMs: number;
  outputBytes: string;
  manualAttentionMs: number;
  attentionMeasurementVersion:
    "foreground-preview-v1" | "operator-attention-v2";
  directProviderCostMinor: string;
  costCurrency: "RUB";
  costBasisVersion: "local-direct-provider-cost-v1";
  incompleteReasons: readonly (typeof PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS)[number][];
}>;

type PublicApprovalJobMetrics = Readonly<{
  initialQueueWaitMs: number | null;
  retryWaitMs: number | null;
  firstStartToFinishMs: number | null;
  activeAttemptMs: number | null;
  attemptCount: number;
  retryCount: number;
}>;

export function projectPublicApprovalEconomicsV2(
  value: unknown,
): PublicApprovalEconomicsV2 | null {
  const row = exactRecord(value, ECONOMICS_KEYS);
  if (!row) return null;
  const workflowMode = row.workflowMode;
  const preparation = publicInteger(row.preparationForegroundMs);
  const finalReview = publicInteger(row.finalReviewForegroundMs);
  const total = publicInteger(row.totalOperatorAttentionMs);
  const metadataCost = publicUnsignedDecimal(row.metadataDirectCostMicrousd);
  const evidenceCost = publicUnsignedDecimal(row.evidenceDirectCostMicrousd);
  const thumbnailCost = publicUnsignedDecimal(row.thumbnailDirectCostMicrousd);
  const combinedCost = publicUnsignedDecimal(row.combinedDirectCostMicrousd);
  if (
    row.schemaVersion !== "approval-economics-v2" ||
    (workflowMode !== "MANUAL" &&
      workflowMode !== "AI_ASSISTED" &&
      workflowMode !== "MIXED") ||
    row.attentionSchemaVersion !== "operator-attention-v2" ||
    preparation === null ||
    finalReview === null ||
    total === null ||
    preparation + finalReview !== total ||
    metadataCost === null ||
    evidenceCost === null ||
    thumbnailCost === null ||
    combinedCost === null ||
    BigInt(metadataCost) + BigInt(evidenceCost) + BigInt(thumbnailCost) !==
      BigInt(combinedCost) ||
    row.currency !== "USD" ||
    row.unit !== "MICRO" ||
    row.assistanceTiming !== null ||
    !Array.isArray(row.incompleteReasons) ||
    row.incompleteReasons.length !== 0 ||
    !publicVersion(row.metadataCostBasisVersion) ||
    !publicVersion(row.evidenceCostBasisVersion) ||
    !publicVersion(row.thumbnailCostBasisVersion) ||
    !publicFingerprint(row.snapshotFingerprint)
  )
    return null;
  return {
    schemaVersion: "approval-economics-v2",
    workflowMode,
    attentionSchemaVersion: "operator-attention-v2",
    preparationForegroundMs: preparation,
    finalReviewForegroundMs: finalReview,
    totalOperatorAttentionMs: total,
    metadataDirectCostMicrousd: metadataCost,
    evidenceDirectCostMicrousd: evidenceCost,
    thumbnailDirectCostMicrousd: thumbnailCost,
    combinedDirectCostMicrousd: combinedCost,
    currency: "USD",
    unit: "MICRO",
    metadataCostBasisVersion: row.metadataCostBasisVersion as string,
    evidenceCostBasisVersion: row.evidenceCostBasisVersion as string,
    thumbnailCostBasisVersion: row.thumbnailCostBasisVersion as string,
    assistanceTiming: null,
    incompleteReasons: [],
    snapshotFingerprint: row.snapshotFingerprint as string,
  };
}

export function projectPublicApprovalProcessingMetrics(
  value: unknown,
): PublicApprovalProcessingMetrics | null {
  const row = exactRecord(value, METRICS_KEYS);
  if (!row) return null;
  const cut = projectJobMetrics(row.cut);
  const assembly = projectJobMetrics(row.assembly);
  const elapsed = nullablePublicInteger(row.cutToAssemblyReadyElapsedMs);
  const duration = publicInteger(row.outputDurationMs);
  const bytes = publicUnsignedDecimal(row.outputBytes);
  const attention = publicInteger(row.manualAttentionMs);
  const cost = publicUnsignedDecimal(row.directProviderCostMinor);
  if (
    row.metricsSchemaVersion !== "approval-metrics-v1" ||
    row.timestampBasisVersion !== "persisted-job-attempt-v1" ||
    !cut ||
    !assembly ||
    elapsed === undefined ||
    duration === null ||
    duration === 0 ||
    bytes === null ||
    BigInt(bytes) === 0n ||
    attention === null ||
    cost === null ||
    row.costCurrency !== "RUB" ||
    row.costBasisVersion !== "local-direct-provider-cost-v1" ||
    (row.attentionMeasurementVersion !== "foreground-preview-v1" &&
      row.attentionMeasurementVersion !== "operator-attention-v2") ||
    !Array.isArray(row.incompleteReasons) ||
    row.incompleteReasons.length >
      PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS.length ||
    row.incompleteReasons.some(
      (reason) =>
        typeof reason !== "string" ||
        !(
          PUBLIC_APPROVAL_METRIC_INCOMPLETE_REASONS as readonly string[]
        ).includes(reason),
    ) ||
    new Set(row.incompleteReasons).size !== row.incompleteReasons.length
  )
    return null;
  return {
    metricsSchemaVersion: "approval-metrics-v1",
    timestampBasisVersion: "persisted-job-attempt-v1",
    cut,
    assembly,
    cutToAssemblyReadyElapsedMs: elapsed,
    outputDurationMs: duration,
    outputBytes: bytes,
    manualAttentionMs: attention,
    attentionMeasurementVersion: row.attentionMeasurementVersion,
    directProviderCostMinor: cost,
    costCurrency: "RUB",
    costBasisVersion: "local-direct-provider-cost-v1",
    incompleteReasons:
      row.incompleteReasons as PublicApprovalProcessingMetrics["incompleteReasons"],
  };
}

function projectJobMetrics(value: unknown): PublicApprovalJobMetrics | null {
  const row = exactRecord(value, JOB_METRIC_KEYS);
  if (!row) return null;
  const initial = nullablePublicInteger(row.initialQueueWaitMs);
  const retry = nullablePublicInteger(row.retryWaitMs);
  const first = nullablePublicInteger(row.firstStartToFinishMs);
  const active = nullablePublicInteger(row.activeAttemptMs);
  const attempts = publicInteger(row.attemptCount);
  const retries = publicInteger(row.retryCount);
  if (
    initial === undefined ||
    retry === undefined ||
    first === undefined ||
    active === undefined ||
    attempts === null ||
    retries === null ||
    retries > attempts
  )
    return null;
  return {
    initialQueueWaitMs: initial,
    retryWaitMs: retry,
    firstStartToFinishMs: first,
    activeAttemptMs: active,
    attemptCount: attempts,
    retryCount: retries,
  };
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
    ? row
    : null;
}

function publicInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nullablePublicInteger(value: unknown): number | null | undefined {
  return value === null ? null : (publicInteger(value) ?? undefined);
}

function publicUnsignedDecimal(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
    ? value
    : null;
}

function publicVersion(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function publicFingerprint(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
