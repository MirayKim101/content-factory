import type { CutJobView } from "@content-factory/manual-cut";
import type { CutJobDto } from "./cut.dto.js";

export function toCutJobDto(job: CutJobView): CutJobDto {
  return {
    id: job.id,
    sourceId: job.sourceId,
    sourceVersion: job.sourceVersion,
    sourceSha256: job.sourceSha256,
    startMs: job.startMs,
    endMs: job.endMs,
    state: job.state,
    stage: job.stage,
    progress: job.progress
      ? {
          current: job.progress.current.toString(),
          total: job.progress.total.toString(),
          unit: job.progress.unit,
        }
      : null,
    attempts: job.attempts,
    queueReason: job.queueReason,
    admissionDeadlineAt: job.admissionDeadlineAt.toISOString(),
    failure: job.failure,
    recipeVersion: job.recipeVersion,
    revision: job.revision,
    artifact: job.artifact
      ? {
          id: job.artifact.id,
          sizeBytes: job.artifact.sizeBytes.toString(),
          sha256: job.artifact.sha256,
          contentType: job.artifact.contentType,
          downloadUrl: `/api/v1/projects/${job.projectId}/cut-jobs/${job.id}/download`,
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
