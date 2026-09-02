import type { ObjectStorage } from "../../projects/application/object-storage.port.js";
import type { PipelineRepository } from "./pipeline-repository.port.js";

export class ReconcileAttemptCleanups {
  constructor(
    private readonly repository: PipelineRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(limit: number): Promise<void> {
    const cleanups = await this.repository.getPendingAttemptCleanups(limit);
    await Promise.allSettled(
      cleanups.map(async (cleanup) => {
        if (!(await this.repository.reserveAttemptCleanup(cleanup))) return;
        try {
          await this.storage.deleteObject(cleanup.objectKey);
          await this.repository.completeAttemptCleanup(cleanup);
        } catch {
          await this.repository.failAttemptCleanup(
            cleanup,
            "OBJECT_DELETE_FAILED",
          );
        }
      }),
    );
  }
}
