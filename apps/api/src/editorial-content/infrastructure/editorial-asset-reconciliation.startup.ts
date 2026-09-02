import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { safeCause } from "../../projects/application/safe-cause.js";
import { ReconcileEditorialAssets } from "../application/reconcile-editorial-assets.js";

@Injectable()
export class EditorialAssetReconciliationStartup implements OnApplicationBootstrap {
  private readonly logger = new Logger(
    EditorialAssetReconciliationStartup.name,
  );

  constructor(
    @Inject(ReconcileEditorialAssets)
    private readonly reconcile: ReconcileEditorialAssets,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const timeoutMs = apiEnvironment().reconcileStartupTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.reconcile.execute(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("EDITORIAL_RECONCILIATION_TIMEOUT")),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.logger.error({
        event: "editorial_reconciliation_startup_failed",
        code: "EDITORIAL_RECONCILIATION_STARTUP_FAILED",
        cause: safeCause(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
