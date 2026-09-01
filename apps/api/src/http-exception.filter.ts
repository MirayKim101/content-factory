import { rmSync } from "node:fs";

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { MulterError } from "multer";

import { UploadError } from "./projects/application/upload-errors.js";
import { safeCause } from "./projects/application/safe-cause.js";

interface ErrorBody {
  error: { code: string; message: string };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<{ file?: { path?: string } }>();
    if (request.file?.path) {
      try {
        rmSync(request.file.path, { force: true });
      } catch {
        // The normal use case also owns cleanup; never replace the original error.
      }
    }

    const { status, body } = this.mapException(exception);
    if (status >= 500) {
      this.logger.error({
        event: "http_request_failed",
        code: body.error.code,
        cause: safeCause(exception),
      });
    }
    this.adapterHost.httpAdapter.reply(context.getResponse(), body, status);
  }

  private mapException(exception: unknown): {
    status: number;
    body: ErrorBody;
  } {
    if (exception instanceof UploadError) {
      return {
        status: exception.httpStatus,
        body: { error: { code: exception.code, message: exception.message } },
      };
    }
    if (exception instanceof MulterError) {
      if (exception.code === "LIMIT_FILE_SIZE") {
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          body: {
            error: {
              code: "UPLOAD_TOO_LARGE",
              message: "The uploaded file is too large.",
            },
          },
        };
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: {
            code: "INVALID_MULTIPART",
            message: "The upload is invalid.",
          },
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
        return {
          status,
          body: {
            error: {
              code: "UPLOAD_TOO_LARGE",
              message: "The uploaded file is too large.",
            },
          },
        };
      }
      const response = exception.getResponse();
      if (typeof response === "object" && response !== null) {
        const candidate = response as { code?: unknown; message?: unknown };
        if (
          typeof candidate.code === "string" &&
          typeof candidate.message === "string"
        ) {
          return {
            status,
            body: {
              error: { code: candidate.code, message: candidate.message },
            },
          };
        }
      }
      return {
        status,
        body: {
          error: {
            code:
              status === HttpStatus.NOT_FOUND
                ? "NOT_FOUND"
                : "VALIDATION_FAILED",
            message:
              status === HttpStatus.NOT_FOUND
                ? "Resource was not found."
                : "Request validation failed.",
          },
        },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred.",
        },
      },
    };
  }
}
