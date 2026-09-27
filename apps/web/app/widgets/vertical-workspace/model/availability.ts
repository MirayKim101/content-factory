import type { VerticalRender } from "~/shared/api/vertical-renders";

type VerticalRenderAvailability = Pick<VerticalRender, "cutPipelineJobId"> & {
  job: Pick<VerticalRender["job"], "state">;
};

const ACTIVE_RENDER_STATES = new Set(["QUEUED", "PROCESSING", "RETRY_WAIT"]);

export function hasActiveVerticalRender(
  renders: readonly VerticalRenderAvailability[],
): boolean {
  return renders.some((render) => ACTIVE_RENDER_STATES.has(render.job.state));
}

export function hasBlockingVerticalRender(
  cutPipelineJobId: string,
  renders: readonly VerticalRenderAvailability[],
): boolean {
  return renders.some(
    (render) =>
      render.cutPipelineJobId === cutPipelineJobId &&
      render.job.state !== "FAILED_FINAL",
  );
}
