import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { SingleFlightTask } from "../../common/single-flight-task.js";
import { ReconcileMontageAssets } from "../application/reconcile-montage-assets.js";

@Injectable()
export class MontageReconciliationStartup
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private readonly task: SingleFlightTask;
  private readonly logger = new Logger(MontageReconciliationStartup.name);
  constructor(
    @Inject(ReconcileMontageAssets)
    private readonly reconcile: ReconcileMontageAssets,
  ) {
    this.task = new SingleFlightTask(() => this.run());
  }
  onApplicationBootstrap() {
    void this.task.run();
    this.timer = setInterval(() => void this.task.run(), 30_000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.task.wait();
  }
  private async run() {
    try {
      await this.reconcile.execute();
    } catch {
      this.logger.error({ event: "montage_reconciliation_failed" });
    }
  }
}
