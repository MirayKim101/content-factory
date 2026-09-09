import type { EditorialExportView } from "../domain/editorial-export.js";
import type { EditorialExportResponseDto } from "./editorial-export.dto.js";

export function editorialExportResponse(
  value: EditorialExportView,
): EditorialExportResponseDto {
  return {
    ...value,
    job: {
      ...value.job,
      nextAttemptAt: value.job.nextAttemptAt?.toISOString() ?? null,
      progress: value.job.progress
        ? {
            ...value.job.progress,
            updatedAt: value.job.progress.updatedAt.toISOString(),
          }
        : null,
    },
    result: value.result
      ? {
          ...value.result,
          sizeBytes: value.result.sizeBytes.toString(),
          manifest: value.result.manifest as object,
          completedAt: value.result.completedAt.toISOString(),
          downloadUrl: `/api/v1/editorial-exports/${value.id}/content`,
        }
      : null,
    createdAt: value.createdAt.toISOString(),
  };
}
