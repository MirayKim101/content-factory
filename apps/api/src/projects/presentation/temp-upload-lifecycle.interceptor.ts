import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import { finalize } from "rxjs";

import {
  UPLOAD_REQUEST_DIRECTORY,
  UPLOAD_RESPONSE_EVENTS,
  UPLOAD_STAGING_RESERVATION,
  type TrackedUploadRequest,
} from "./secure-disk-storage.js";
import { UPLOAD_STAGING_MAX_BYTES } from "./upload-staging-admission.metadata.js";
import {
  UploadStagingAdmissionService,
  UploadStagingUnavailableException,
} from "./upload-staging-admission.service.js";

@Injectable()
export class TempUploadLifecycleInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly staging: UploadStagingAdmissionService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<TrackedUploadRequest>();
    const response = context.switchToHttp().getResponse<Express.Response>();
    const maximumBytes = this.reflector.get<number>(
      UPLOAD_STAGING_MAX_BYTES,
      context.getHandler(),
    );
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new UploadStagingUnavailableException();
    }
    const reservation = await this.staging.reserve(maximumBytes);
    if (isTransportClosed(request, response)) {
      reservation.release();
      throw new UploadStagingUnavailableException();
    }
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(reservation.rootDirectory, "request-"));
      chmodSync(directory, 0o700);
    } catch {
      if (directory) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // Preserve the staging failure as the public result.
        }
      }
      reservation.release();
      throw new UploadStagingUnavailableException();
    }
    if (!directory) throw new UploadStagingUnavailableException();
    request[UPLOAD_REQUEST_DIRECTORY] = directory;
    request[UPLOAD_STAGING_RESERVATION] = reservation;
    request[UPLOAD_RESPONSE_EVENTS] = response;
    const requestEvents = request as unknown as EventTargetLike;
    const responseEvents = response as unknown as EventTargetLike;

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // The request's original failure remains authoritative.
      } finally {
        reservation.release();
      }
    };
    requestEvents.once("aborted", cleanup);
    responseEvents.once("close", cleanup);
    if (isTransportClosed(request, response)) {
      cleanup();
      throw new UploadStagingUnavailableException();
    }

    try {
      return next.handle().pipe(
        finalize(() => {
          requestEvents.removeListener("aborted", cleanup);
          responseEvents.removeListener("close", cleanup);
          cleanup();
        }),
      );
    } catch (error) {
      requestEvents.removeListener("aborted", cleanup);
      responseEvents.removeListener("close", cleanup);
      cleanup();
      throw error;
    }
  }
}

function isTransportClosed(
  request: TrackedUploadRequest,
  response: Express.Response,
): boolean {
  const requestTransport = request as unknown as TransportState;
  const responseTransport = response as unknown as TransportState;
  return Boolean(
    requestTransport.aborted ||
    requestTransport.destroyed ||
    responseTransport.destroyed,
  );
}

interface TransportState {
  aborted?: boolean;
  destroyed?: boolean;
}

interface EventTargetLike {
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}
