import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { ReconcilePendingUploads } from "../application/reconcile-pending-uploads.js";

@Injectable()
export class PendingUploadReconciliationStartup
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingUploadReconciliationStartup.name);
  private controller?: AbortController;
  private execution: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(private readonly reconciliation: ReconcilePendingUploads) {}

  onApplicationBootstrap(): void {
    const config = apiEnvironment();
    const cutoff = new Date(Date.now() - config.reconcileStaleAfterMs);
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(
      () =>
        controller.abort(new Error("SOURCE_PENDING_RECONCILIATION_TIMEOUT")),
      config.reconcileStartupTimeoutMs,
    );
    timer.unref();
    this.execution = this.reconciliation
      .execute(cutoff, config.reconcileLimit, controller.signal)
      .then((count) => {
        if (count > 0)
          this.logger.log(`Reconciled ${count} stale source upload(s).`);
      })
      .catch((error: unknown) => {
        if (this.shuttingDown && controller.signal.aborted) return;
        const code =
          error instanceof Error
            ? error.message
            : "SOURCE_PENDING_RECONCILIATION_FAILED";
        this.logger.error(code);
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.controller === controller) this.controller = undefined;
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.controller?.abort(new Error("SOURCE_PENDING_RECONCILIATION_SHUTDOWN"));
    await this.execution;
  }
}
