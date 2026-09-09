import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";

import { AI_CONTEXT_ADMISSION_ENABLED } from "../application/creator-context-repository.port.js";

@Injectable()
export class AiContextAdmissionInterceptor implements NestInterceptor {
  constructor(
    @Inject(AI_CONTEXT_ADMISSION_ENABLED)
    private readonly enabled: boolean,
  ) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (!this.enabled) {
      throw new HttpException(
        {
          code: "AI_CONTEXT_DISABLED",
          message: "Creator context changes are currently disabled.",
        },
        503,
      );
    }
    return next.handle();
  }
}
