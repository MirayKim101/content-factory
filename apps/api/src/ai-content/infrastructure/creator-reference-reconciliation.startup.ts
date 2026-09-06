import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { ReconcileCreatorReferences } from "../application/reconcile-creator-references.js";

@Injectable()
export class CreatorReferenceReconciliationStartup implements OnApplicationBootstrap {
  constructor(
    @Inject(ReconcileCreatorReferences)
    private readonly reconcile: ReconcileCreatorReferences,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const environment = apiEnvironment();
    // The admission-off API must remain bootable before the additive migration
    // is deployed. Do not touch Stage 2B tables until the feature is enabled.
    if (!environment.aiContextEnabled) return;
    await this.reconcile.execute({
      staleBefore: new Date(Date.now() - environment.reconcileStaleAfterMs),
      limit: environment.reconcileLimit,
    });
  }
}
