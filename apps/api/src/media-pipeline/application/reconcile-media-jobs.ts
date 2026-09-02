import { Inject, Injectable } from "@nestjs/common";

import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import { JOB_DISPATCH, type JobDispatch } from "./job-dispatch.port.js";
import {
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "./pipeline-repository.port.js";
import { ReconcileAttemptCleanups } from "./reconcile-attempt-cleanups.js";

@Injectable()
export class ReconcileMediaJobs {
  constructor(
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
    @Inject(JOB_DISPATCH) private readonly dispatch: JobDispatch,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async execute(limit: number): Promise<void> {
    const probes = await this.repository.ensureProbeJobs(limit);
    const recovered = await this.repository.recoverExpiredLeases(limit);
    await new ReconcileAttemptCleanups(this.repository, this.storage).execute(
      limit,
    );
    const deliveries = [
      ...probes,
      ...recovered,
      ...(await this.repository.getRunnableJobs(limit)),
    ];
    const unique = new Map(
      deliveries.map((delivery) => [
        `${delivery.jobId}:${delivery.attemptNumber}`,
        delivery,
      ]),
    );
    await Promise.allSettled(
      [...unique.values()].map((delivery) => this.dispatch.dispatch(delivery)),
    );
  }
}
