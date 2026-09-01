import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { ReconcilePendingUploads } from "../application/reconcile-pending-uploads.js";

@Injectable()
export class PendingUploadReconciliationStartup implements OnApplicationBootstrap {
  private readonly logger = new Logger(PendingUploadReconciliationStartup.name);

  constructor(private readonly reconciliation: ReconcilePendingUploads) {}

  onApplicationBootstrap(): void {
    const config = apiEnvironment();
    const cutoff = new Date(Date.now() - config.reconcileStaleAfterMs);
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new Error("SOURCE_PENDING_RECONCILIATION_TIMEOUT")),
      config.reconcileStartupTimeoutMs,
    );
    timer.unref();
    void this.reconciliation
      .execute(cutoff, config.reconcileLimit, controller.signal)
      .then((count) => {
        if (count > 0)
          this.logger.log(`Reconciled ${count} stale source upload(s).`);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof Error
            ? error.message
            : "SOURCE_PENDING_RECONCILIATION_FAILED";
        this.logger.error(code);
      })
      .finally(() => clearTimeout(timer));
  }
}
