import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { SingleFlightTask } from "../../common/single-flight-task.js";
import { apiEnvironment } from "../../config/environment.js";
import { ReconcileMediaJobs } from "../application/reconcile-media-jobs.js";

@Injectable()
export class MediaReconciliationStartup
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private readonly task: SingleFlightTask;

  constructor(private readonly reconcile: ReconcileMediaJobs) {
    this.task = new SingleFlightTask(() => this.run());
  }

  async onApplicationBootstrap(): Promise<void> {
    const config = apiEnvironment();
    await this.task.run();
    this.timer = setInterval(
      () => void this.task.run(),
      config.mediaReconcileIntervalMs,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.task.wait();
  }

  private async run(): Promise<void> {
    try {
      await this.reconcile.execute(apiEnvironment().mediaReconcileLimit);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "media_reconciliation_failed",
          error: error instanceof Error ? error.message : "UNKNOWN",
        }),
      );
    }
  }
}
