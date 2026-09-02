import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { ReconcileMediaJobs } from "../application/reconcile-media-jobs.js";

@Injectable()
export class MediaReconciliationStartup
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly reconcile: ReconcileMediaJobs) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = apiEnvironment();
    await this.run(config.mediaReconcileLimit);
    this.timer = setInterval(
      () => void this.run(config.mediaReconcileLimit),
      config.mediaReconcileIntervalMs,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(limit: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcile.execute(limit);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "media_reconciliation_failed",
          error: error instanceof Error ? error.message : "UNKNOWN",
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
