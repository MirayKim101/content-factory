import type { ServerResponse } from "node:http";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Head,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { apiEnvironment } from "../../config/environment.js";
import {
  JOB_DISPATCH,
  type JobDispatch,
} from "../../media-pipeline/application/job-dispatch.port.js";
import { ObjectRangeNotSatisfiableError } from "../../projects/application/object-storage.port.js";
import { SourceAuthorizationRequiredError } from "../../projects/domain/source-authorization.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import {
  CREATOR_CONTEXT_STORAGE,
  type CreatorContextStorage,
} from "../application/creator-context-storage.port.js";
import {
  FRAME_EVIDENCE_REPOSITORY,
  type FrameEvidenceRepository,
} from "../application/frame-evidence-repository.port.js";
import { CreatorContextError, isUuidV4 } from "../domain/creator-context.js";
import { FrameContextRejectedError } from "../infrastructure/prisma-frame-context.js";
import {
  CreateFrameEvidenceDto,
  FrameEvidenceDto,
  FrameEvidenceListDto,
  FrameEvidenceErrorResponseDto,
} from "./frame-evidence.dto.js";

const uuid = new ParseUUIDPipe({ version: "4" });
const JPEG_CONTENT = {
  "image/jpeg": { schema: { type: "string", format: "binary" } },
};
const PRIVATE_JPEG_HEADERS = {
  "Accept-Ranges": { schema: { type: "string", example: "bytes" } },
  "Content-Length": { schema: { type: "integer", minimum: 0 } },
  "Content-Type": { schema: { type: "string", example: "image/jpeg" } },
  ETag: {
    schema: { type: "string" },
    description: "Quoted immutable SHA-256.",
  },
  "Cache-Control": { schema: { type: "string", example: "private, no-store" } },
  "X-Content-Type-Options": { schema: { type: "string", example: "nosniff" } },
};
const RANGE_HEADERS = {
  ...PRIVATE_JPEG_HEADERS,
  "Content-Range": { schema: { type: "string", example: "bytes 0-99/1000" } },
};
const UNSATISFIABLE_HEADERS = {
  "Accept-Ranges": PRIVATE_JPEG_HEADERS["Accept-Ranges"],
  "Content-Range": { schema: { type: "string", example: "bytes */1000" } },
};
function storageUnavailable(): HttpException {
  return new HttpException(
    {
      code: "FRAME_STORAGE_UNAVAILABLE",
      message: "Хранилище кадров временно недоступно.",
    },
    503,
  );
}

@ApiTags("frame-evidence")
@ApiResponse({
  status: 400,
  type: FrameEvidenceErrorResponseDto,
  description: "Invalid UUID/body/idempotency key or pagination.",
})
@ApiResponse({
  status: 404,
  type: FrameEvidenceErrorResponseDto,
  description: "Exact intent/frame identity or private object not found.",
})
@ApiResponse({
  status: 409,
  type: FrameEvidenceErrorResponseDto,
  description:
    "Idempotency conflict, stale context, unsupported input or SOURCE_AUTHORIZATION_REQUIRED.",
})
@ApiResponse({
  status: 503,
  type: FrameEvidenceErrorResponseDto,
  description:
    "Admission disabled, private storage unavailable or integrity mismatch.",
})
@Controller("api/v1")
export class FrameEvidenceController {
  constructor(
    @Inject(FRAME_EVIDENCE_REPOSITORY)
    private readonly repository: FrameEvidenceRepository,
    @Inject(CREATOR_CONTEXT_STORAGE)
    private readonly storage: CreatorContextStorage,
    @Inject(JOB_DISPATCH) private readonly dispatch: JobDispatch,
  ) {}

  @Post("pipeline-jobs/:cutJobId/frame-evidence")
  @HttpCode(202)
  @ApiParam({ name: "cutJobId", format: "uuid", type: String })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: {
      type: "string",
      minLength: 8,
      maxLength: 200,
      pattern: "^[A-Za-z0-9._:-]{8,200}$",
    },
  })
  @ApiAcceptedResponse({ type: FrameEvidenceDto })
  @ApiBody({ type: CreateFrameEvidenceDto, required: true })
  async create(
    @Param("cutJobId", uuid) cutPipelineJobId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateFrameEvidenceDto,
  ) {
    const environment = apiEnvironment();
    if (!environment.aiContextEnabled || !environment.editorialFramesEnabled)
      throw new HttpException(
        {
          code: "EDITORIAL_FRAMES_DISABLED",
          message: "Подготовка кадров сейчас отключена.",
        },
        503,
      );
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Нужен ключ операции.",
      });
    if (
      !body ||
      typeof body.sourceContextRevisionId !== "string" ||
      typeof body.cutPromptRevisionId !== "string" ||
      !isUuidV4(body.sourceContextRevisionId) ||
      !isUuidV4(body.cutPromptRevisionId) ||
      Object.keys(body).some(
        (field) =>
          !["sourceContextRevisionId", "cutPromptRevisionId"].includes(field),
      )
    ) {
      throw new BadRequestException({
        code: "FRAME_REQUEST_INVALID",
        message: "Нужны точные версии контекста и задания нарезки.",
      });
    }
    try {
      const id = await this.repository.create({
        cutPipelineJobId,
        sourceContextRevisionId: body.sourceContextRevisionId,
        cutPromptRevisionId: body.cutPromptRevisionId,
        idempotencyKey: key,
      });
      const detail = await this.repository.detail(id);
      if (!detail) throw new NotFoundException();
      if (["QUEUED", "RETRY_WAIT"].includes(detail.job.state)) {
        await Promise.allSettled([
          this.dispatch.dispatch({
            jobId: detail.pipelineJobId,
            attemptNumber: detail.job.attempt + 1,
          }),
        ]);
      }
      return detail;
    } catch (error) {
      rethrow(error);
    }
  }

  @Get("pipeline-jobs/:cutJobId/frame-evidence")
  @ApiParam({ name: "cutJobId", format: "uuid", type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: FrameEvidenceListDto })
  async list(
    @Param("cutJobId", uuid) cutJobId: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException({
        code: "PAGINATION_INVALID",
        message: "Размер страницы должен быть от 1 до 50.",
      });
    try {
      return await this.repository.list(cutJobId, limit, cursor);
    } catch (error) {
      rethrow(error);
    }
  }

  @Get("frame-evidence/:intentId")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiOkResponse({ type: FrameEvidenceDto })
  async detail(@Param("intentId", uuid) intentId: string) {
    const view = await this.repository.detail(intentId);
    if (!view)
      throw new NotFoundException({
        code: "FRAME_EVIDENCE_NOT_FOUND",
        message: "Набор кадров не найден.",
      });
    return view;
  }

  @Head("frame-evidence/:intentId/frames/:frameId/content")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiParam({ name: "frameId", format: "uuid", type: String })
  @ApiHeader({
    name: "Range",
    required: false,
    schema: { type: "string" },
    description:
      "One RFC byte range: bytes=start-end, bytes=start- or bytes=-suffix; multiple ranges are unsupported.",
  })
  @ApiResponse({
    status: 200,
    description: "Private JPEG headers.",
    headers: PRIVATE_JPEG_HEADERS,
  })
  @ApiResponse({
    status: 206,
    description: "Single range headers.",
    headers: RANGE_HEADERS,
  })
  @ApiResponse({
    status: 416,
    description: "Unsatisfiable byte range.",
    type: FrameEvidenceErrorResponseDto,
    headers: UNSATISFIABLE_HEADERS,
  })
  async head(
    @Param("intentId", uuid) intentId: string,
    @Param("frameId", uuid) frameId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.stream(intentId, frameId, range, response, true);
  }

  @Get("frame-evidence/:intentId/frames/:frameId/content")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiParam({ name: "frameId", format: "uuid", type: String })
  @ApiHeader({
    name: "Range",
    required: false,
    schema: { type: "string" },
    description:
      "One RFC byte range: bytes=start-end, bytes=start- or bytes=-suffix; multiple ranges are unsupported.",
  })
  @ApiResponse({
    status: 200,
    description: "Private JPEG bytes.",
    headers: PRIVATE_JPEG_HEADERS,
    content: JPEG_CONTENT,
  })
  @ApiResponse({
    status: 206,
    description: "Single byte range.",
    headers: RANGE_HEADERS,
    content: JPEG_CONTENT,
  })
  @ApiResponse({
    status: 416,
    description: "Unsatisfiable byte range.",
    type: FrameEvidenceErrorResponseDto,
    headers: UNSATISFIABLE_HEADERS,
  })
  async content(
    @Param("intentId", uuid) intentId: string,
    @Param("frameId", uuid) frameId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.stream(intentId, frameId, range, response, false);
  }

  private async stream(
    intentId: string,
    frameId: string,
    range: string | undefined,
    response: ServerResponse,
    head: boolean,
  ): Promise<void> {
    try {
      const found = await this.repository.content(intentId, frameId);
      if (!found)
        throw new NotFoundException({
          code: "FRAME_CONTENT_NOT_FOUND",
          message: "Кадр не найден.",
        });
      const size = found.measurement.sizeBytes;
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      const interval = parseFrameRange(range, size);
      if (interval === null) {
        response.setHeader("Content-Range", `bytes */${size}`);
        throw new HttpException(
          { code: "RANGE_NOT_SATISFIABLE", message: "Диапазон недоступен." },
          416,
        );
      }
      let metadata;
      try {
        metadata = await this.storage.headObject(found.objectKey);
      } catch {
        throw storageUnavailable();
      }
      if (!metadata)
        throw new NotFoundException({
          code: "FRAME_CONTENT_NOT_FOUND",
          message: "Файл кадра недоступен.",
        });
      if (
        metadata.sizeBytes !== size ||
        metadata.sha256 !== found.measurement.sha256
      ) {
        throw new HttpException(
          {
            code: "FRAME_CONTENT_INVALID",
            message: "Файл кадра не прошёл проверку.",
          },
          503,
        );
      }
      response.statusCode = range === undefined ? 200 : 206;
      response.setHeader("Content-Type", "image/jpeg");
      response.setHeader(
        "Content-Length",
        String(interval.end - interval.start + 1),
      );
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("ETag", `"${found.measurement.sha256}"`);
      response.setHeader(
        "Content-Disposition",
        `inline; filename="frame-${found.measurement.ordinal}.jpg"`,
      );
      if (range !== undefined)
        response.setHeader(
          "Content-Range",
          `bytes ${interval.start}-${interval.end}/${size}`,
        );
      if (head) {
        response.end();
        return;
      }
      let stored;
      try {
        stored = await this.storage.readObject(
          found.objectKey,
          range === undefined
            ? undefined
            : `bytes=${interval.start}-${interval.end}`,
        );
      } catch (error) {
        if (error instanceof ObjectRangeNotSatisfiableError) {
          response.setHeader("Content-Range", `bytes */${size}`);
          throw error;
        }
        throw storageUnavailable();
      }
      if (!stored)
        throw new NotFoundException({
          code: "FRAME_CONTENT_NOT_FOUND",
          message: "Файл кадра недоступен.",
        });
      if (stored.contentLength !== interval.end - interval.start + 1) {
        stored.body.destroy();
        throw new HttpException(
          {
            code: "FRAME_CONTENT_INVALID",
            message: "Файл кадра не прошёл проверку.",
          },
          503,
        );
      }
      stored.body.on("error", () => response.destroy());
      response.once("close", () => stored.body.destroy());
      stored.body.pipe(response);
    } catch (error) {
      // Nest must set the error body's length, not retain a JPEG length header.
      if (!response.headersSent) {
        response.removeHeader("Content-Length");
        response.removeHeader("Content-Type");
      }
      rethrow(error);
    }
  }
}

export function parseFrameRange(
  range: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (range === undefined) return { start: 0, end: size - 1 };
  if (range.length > 100) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, size - suffix), end: size - 1 }
      : null;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function rethrow(error: unknown): never {
  if (error instanceof AiContentIdempotencyConflictError)
    throw new ConflictException({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Ключ уже использован для другой операции.",
    });
  if (error instanceof FrameContextRejectedError)
    throw new ConflictException({
      code: "FRAME_CONTEXT_REQUIRED",
      message: "Сохраните актуальный контекст нарезки.",
    });
  if (error instanceof SourceAuthorizationRequiredError)
    throw new ConflictException({
      code: "SOURCE_AUTHORIZATION_REQUIRED",
      message: "Нет действующего разрешения на источник.",
    });
  if (error instanceof CreatorContextError)
    throw new HttpException(
      { code: error.code, message: error.message },
      error.httpStatus,
    );
  if (error instanceof ObjectRangeNotSatisfiableError)
    throw new HttpException(
      { code: "RANGE_NOT_SATISFIABLE", message: "Диапазон недоступен." },
      416,
    );
  if (error instanceof Error && error.message === "FRAME_INPUT_UNSUPPORTED")
    throw new ConflictException({
      code: "FRAME_INPUT_UNSUPPORTED",
      message: "Нарезка не подходит для подготовки кадров.",
    });
  throw error;
}
