import type {
  CreateCutsResult,
  PipelineJobView,
} from "../domain/pipeline-job.js";
import type {
  CreateCutsResponseDto,
  PipelineJobResponseDto,
} from "./pipeline.dto.js";

export function toPipelineJobResponse(
  job: PipelineJobView,
): PipelineJobResponseDto {
  return {
    id: job.id,
    clientSegmentId: job.clientSegmentId,
    revision: job.revision,
    state: job.state,
    startMs: job.startMs,
    endMs: job.endMs,
    ...(job.processedMs === undefined ? {} : { processedMs: job.processedMs }),
    ...(job.totalMs === undefined ? {} : { totalMs: job.totalMs }),
    attempt: job.attempt,
    retryBudget: job.retryBudget,
    ...(job.failure ? { failure: job.failure } : {}),
    ...(job.result
      ? {
          result: {
            filename: job.result.filename,
            sizeBytes: job.result.sizeBytes.toString(),
            sha256: job.result.sha256,
            downloadUrl: `/api/v1/pipeline-jobs/${job.id}/result`,
          },
        }
      : {}),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function toCreateCutsResponse(
  result: CreateCutsResult,
): CreateCutsResponseDto {
  return {
    requestId: result.requestId,
    projectId: result.projectId,
    jobs: result.jobs.map(toPipelineJobResponse),
  };
}
