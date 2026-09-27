import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { safeCause } from "../../projects/application/safe-cause.js";
import { ReconcileEditorialAssets } from "../application/reconcile-editorial-assets.js";

@Injectable()
export class EditorialAssetReconciliationStartup
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    EditorialAssetReconciliationStartup.name,
  );
  private controller?: AbortController;
  private execution: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    @Inject(ReconcileEditorialAssets)
    private readonly reconcile: ReconcileEditorialAssets,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const timeoutMs = apiEnvironment().reconcileStartupTimeoutMs;
    const controller = new AbortController();
    this.controller = controller;
    let timer: NodeJS.Timeout | undefined;
    this.execution = this.reconcile.execute(controller.signal);
    try {
      await Promise.race([
        this.execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("EDITORIAL_RECONCILIATION_TIMEOUT");
            controller.abort(error);
            reject(error);
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (!this.shuttingDown)
        this.logger.error({
          event: "editorial_reconciliation_startup_failed",
          code: "EDITORIAL_RECONCILIATION_STARTUP_FAILED",
          cause: safeCause(error),
        });
    } finally {
      if (timer) clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.controller?.abort(new Error("EDITORIAL_RECONCILIATION_SHUTDOWN"));
    await this.execution.catch(() => undefined);
  }
}
