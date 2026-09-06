import { mkdir, statfs } from "node:fs/promises";
import {
  Inject,
  Injectable,
  HttpException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { finalize } from "rxjs";
import { apiEnvironment } from "../../config/environment.js";
import {
  MONTAGE_REPOSITORY,
  type MontageRepository,
} from "../application/montage-repository.port.js";
import { MONTAGE_MAX_BYTES, MontageError } from "../domain/montage-asset.js";
import { isUuidV4 } from "./montage-identifier.js";

// Local single-process deployment: two bounded uploads, each reserving 256 MiB.
// Scaling API replicas requires a shared admission budget before increasing this cap.
@Injectable()
export class MontageUploadAdmissionInterceptor implements NestInterceptor {
  private active = 0;
  constructor(
    @Inject(MONTAGE_REPOSITORY) private readonly repository: MontageRepository,
  ) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      params: Record<string, unknown>;
      destroy(error?: Error): void;
    }>();
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new HttpException(
        {
          code: "IDEMPOTENCY_KEY_INVALID",
          message: "A valid Idempotency-Key is required.",
        },
        400,
      );
    const projectId = request.params.projectId;
    if (!isUuidV4(projectId))
      throw new HttpException(
        { code: "PROJECT_ID_INVALID", message: "Invalid project identifier." },
        400,
      );
    try {
      await this.repository.authorize(projectId);
    } catch (error) {
      if (error instanceof MontageError)
        throw new HttpException(
          { code: error.code, message: error.message },
          error.httpStatus,
        );
      throw error;
    }
    if (this.active >= 2)
      throw new HttpException(
        {
          code: "MONTAGE_UPLOAD_BUSY",
          message: "Two montage uploads are already active. Retry later.",
        },
        429,
      );
    this.active += 1;
    try {
      const root = apiEnvironment().uploadTempDirectory;
      await mkdir(root, { recursive: true, mode: 0o700 });
      const disk = await statfs(root, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(2 * MONTAGE_MAX_BYTES + 1024 ** 3))
        throw new HttpException(
          {
            code: "MONTAGE_STAGING_FULL",
            message: "Not enough upload staging space.",
          },
          503,
        );
      // Absolute deadline, not merely an idle socket timeout; slow multipart clients cannot hold admission forever.
      const timer = setTimeout(
        () => request.destroy(new Error("MONTAGE_UPLOAD_TIMEOUT")),
        120_000,
      );
      timer.unref();
      return next.handle().pipe(
        finalize(() => {
          clearTimeout(timer);
          this.active -= 1;
        }),
      );
    } catch (error) {
      this.active -= 1;
      throw error;
    }
  }
}
