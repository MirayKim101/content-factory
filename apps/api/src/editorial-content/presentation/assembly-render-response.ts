import type { AssemblyRenderView } from "../domain/assembly-render.js";
import type { AssemblyRenderResponseDto } from "./assembly-render.dto.js";

export function assemblyRenderResponse(
  value: AssemblyRenderView,
): AssemblyRenderResponseDto {
  return {
    ...value,
    inputs: value.inputs.map((input) => ({
      ...input,
      sizeBytes: input.sizeBytes.toString(),
    })),
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
          completedAt: value.result.completedAt.toISOString(),
          downloadUrl: `/api/v1/assembly-renders/${value.id}/content`,
        }
      : null,
    createdAt: value.createdAt.toISOString(),
  };
}
