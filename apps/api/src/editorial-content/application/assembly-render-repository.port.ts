import type { JobDelivery } from "../../media-pipeline/application/job-dispatch.port.js";
import type { AssemblyRenderView } from "../domain/assembly-render.js";

export const ASSEMBLY_RENDER_REPOSITORY = Symbol("ASSEMBLY_RENDER_REPOSITORY");
export const ASSEMBLY_RENDER_ADMISSION_ENABLED = Symbol(
  "ASSEMBLY_RENDER_ADMISSION_ENABLED",
);

export interface AssemblyRenderRepository {
  create(input: {
    intentId: string;
    requestId: string;
    jobId: string;
    attemptId: string;
    cutPipelineJobId: string;
    recipeRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<{ view: AssemblyRenderView; delivery: JobDelivery }>;
  get(renderId: string): Promise<AssemblyRenderView | null>;
  listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<AssemblyRenderView[]>;
  getContent(renderId: string): Promise<{
    objectKey: string;
    sizeBytes: bigint;
    filename: string;
  } | null>;
}
