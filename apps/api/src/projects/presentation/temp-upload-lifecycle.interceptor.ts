import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs";

import { apiEnvironment } from "../../config/environment.js";
import {
  UPLOAD_REQUEST_DIRECTORY,
  type TrackedUploadRequest,
} from "./secure-disk-storage.js";

@Injectable()
export class TempUploadLifecycleInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<TrackedUploadRequest>();
    const response = context.switchToHttp().getResponse<Express.Response>();
    const root = apiEnvironment().uploadTempDirectory;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const directory = mkdtempSync(join(root, "request-"));
    chmodSync(directory, 0o700);
    request[UPLOAD_REQUEST_DIRECTORY] = directory;
    const requestEvents = request as unknown as EventTargetLike;
    const responseEvents = response as unknown as EventTargetLike;

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    };
    requestEvents.once("aborted", cleanup);
    responseEvents.once("close", cleanup);

    return next.handle().pipe(
      finalize(() => {
        requestEvents.removeListener("aborted", cleanup);
        responseEvents.removeListener("close", cleanup);
        cleanup();
      }),
    );
  }
}

interface EventTargetLike {
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}
