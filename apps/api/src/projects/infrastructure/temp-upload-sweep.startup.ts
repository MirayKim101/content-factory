import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { safeCause } from "../application/safe-cause.js";
import { ensurePrivateUploadRoot } from "../presentation/upload-staging-admission.service.js";

@Injectable()
export class TempUploadSweepStartup implements OnApplicationBootstrap {
  private readonly logger = new Logger(TempUploadSweepStartup.name);

  onApplicationBootstrap(): void {
    void this.sweep().catch((error: unknown) => {
      this.logger.error({
        event: "upload_temp_sweep_failed",
        code: "UPLOAD_TEMP_SWEEP_FAILED",
        cause: safeCause(error),
      });
    });
  }

  async sweep(now = Date.now()): Promise<number> {
    const config = apiEnvironment();
    const rootDirectory = await ensurePrivateUploadRoot(
      config.uploadTempDirectory,
    );
    let entries;
    try {
      entries = await readdir(rootDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (removed >= config.uploadTempSweepLimit) break;
      if (!entry.isDirectory() || !entry.name.startsWith("request-")) continue;
      const directory = join(rootDirectory, entry.name);
      const metadata = await stat(directory);
      if (now - metadata.mtimeMs < config.uploadTempStaleAfterMs) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
