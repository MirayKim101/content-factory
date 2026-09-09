import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ReconcileMontageAssets } from "../application/reconcile-montage-assets.js";

@Injectable()
export class MontageReconciliationStartup
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(MontageReconciliationStartup.name);
  constructor(
    @Inject(ReconcileMontageAssets)
    private readonly reconcile: ReconcileMontageAssets,
  ) {}
  onApplicationBootstrap() {
    void this.run();
    this.timer = setInterval(() => void this.run(), 30_000);
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcile.execute();
    } catch {
      this.logger.error({ event: "montage_reconciliation_failed" });
    } finally {
      this.running = false;
    }
  }
}
