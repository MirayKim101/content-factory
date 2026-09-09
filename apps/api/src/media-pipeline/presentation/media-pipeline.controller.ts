import type { ServerResponse } from "node:http";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiConflictResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";

import {
  OBJECT_STORAGE,
  ObjectRangeNotSatisfiableError,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import { SourceAuthorizationRequiredError } from "../../projects/domain/source-authorization.js";
import { CreateCuts } from "../application/create-cuts.js";
import { GetPipelineJob } from "../application/get-pipeline-job.js";
import { ListProjectCutJobs } from "../application/list-project-cut-jobs.js";
import {
  CutBoundsInvalidError,
  CutDurationUnavailableError,
  CutIdempotencyConflictError,
  CutSourceNotReadyError,
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "../application/pipeline-repository.port.js";
import {
  CreateCutsDto,
  CreateCutsResponseDto,
  PipelineJobResponseDto,
  ProjectCutJobsResponseDto,
} from "./pipeline.dto.js";
import {
  toCreateCutsResponse,
  toPipelineJobResponse,
} from "./pipeline-response.js";

const VIDEO_RESPONSE_CONTENT = {
  "video/mp4": { schema: { type: "string", format: "binary" } },
};
const BYTE_RANGE_HEADERS = {
  "Accept-Ranges": {
    description: "Supported range unit.",
    schema: { type: "string", example: "bytes" },
  },
  "Content-Range": {
    description: "Returned or unsatisfied byte range.",
    schema: { type: "string", example: "bytes 0-1023/4096" },
  },
};
const UNSATISFIED_RANGE_HEADERS = {
  "Accept-Ranges": BYTE_RANGE_HEADERS["Accept-Ranges"],
  "Content-Range": {
    description: "Unsatisfied range with the authoritative object size.",
    schema: { type: "string", example: "bytes */4096" },
  },
};

@ApiTags("media-pipeline")
@ApiExtraModels(ErrorResponseDto)
@Controller("api/v1")
export class MediaPipelineController {
  constructor(
    @Inject(CreateCuts) private readonly createCuts: CreateCuts,
    @Inject(GetPipelineJob) private readonly getPipelineJob: GetPipelineJob,
    @Inject(ListProjectCutJobs)
    private readonly listProjectCutJobs: ListProjectCutJobs,
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post("projects/:projectId/cuts")
  @ApiOperation({
    summary: "Atomically create one independent background job per cut segment",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateCutsDto })
  @ApiCreatedResponse({ type: CreateCutsResponseDto })
  @ApiConflictResponse({
    description: "Key belongs to a different request or source is not ready.",
  })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateCutsDto,
  ): Promise<CreateCutsResponseDto> {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "A valid Idempotency-Key header is required.",
      });
    }
    const ids = new Set(
      body.segments.map((segment) => segment.clientSegmentId),
    );
    const bounds = new Set(
      body.segments.map((segment) => `${segment.startMs}:${segment.endMs}`),
    );
    if (
      ids.size !== body.segments.length ||
      bounds.size !== body.segments.length
    ) {
      throw new BadRequestException({
        code: "CUT_SEGMENTS_DUPLICATE",
        message: "Each segment and its bounds must be unique.",
      });
    }
    try {
      return toCreateCutsResponse(
        await this.createCuts.execute({
          projectId,
          idempotencyKey,
          segments: body.segments,
        }),
      );
    } catch (error) {
      if (error instanceof CutIdempotencyConflictError) {
        throw new ConflictException({
          code: "IDEMPOTENCY_CONFLICT",
          message: "This key belongs to a different cut request.",
        });
      }
      if (error instanceof CutSourceNotReadyError) {
        throw new ConflictException({
          code: "SOURCE_NOT_READY",
          message: "The source is not ready for cutting.",
        });
      }
      if (error instanceof SourceAuthorizationRequiredError) {
        throw new HttpException(
          {
            code: "SOURCE_AUTHORIZATION_REQUIRED",
            message:
              "Explicit authorization is required for this source version.",
          },
          HttpStatus.FORBIDDEN,
        );
      }
      if (error instanceof CutDurationUnavailableError) {
        throw new ConflictException({
          code: "SOURCE_DURATION_UNAVAILABLE",
          message: "The source duration is still being checked.",
        });
      }
      if (error instanceof CutBoundsInvalidError) {
        throw new UnprocessableEntityException({
          code: "CUT_BOUNDS_INVALID",
          message: `Segment ${error.clientSegmentId} is outside the source duration (${error.durationMs} ms).`,
        });
      }
      throw error;
    }
  }

  @Get("pipeline-jobs/:id")
  @ApiOkResponse({ type: PipelineJobResponseDto })
  async job(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<PipelineJobResponseDto> {
    const job = await this.getPipelineJob.execute(id);
    if (!job)
      throw new NotFoundException({
        code: "PIPELINE_JOB_NOT_FOUND",
        message: "Pipeline job was not found.",
      });
    return toPipelineJobResponse(job);
  }

  @Get("projects/:projectId/pipeline-jobs")
  @ApiOperation({ summary: "List persisted cut jobs for the current source" })
  @ApiOkResponse({ type: ProjectCutJobsResponseDto })
  async projectJobs(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query("limit") rawLimit?: string,
  ): Promise<ProjectCutJobsResponseDto> {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({
        code: "PIPELINE_JOB_LIMIT_INVALID",
        message: "Limit must be an integer between 1 and 100.",
      });
    }
    try {
      return {
        items: (await this.listProjectCutJobs.execute(projectId, limit)).map(
          toPipelineJobResponse,
        ),
      };
    } catch (error) {
      this.rethrowAuthorization(error);
    }
  }

  @Get("projects/:projectId/source")
  @ApiProduces("video/mp4")
  @ApiHeader({
    name: "Range",
    required: false,
    description: "One RFC 9110 byte range, for example bytes=0-1048575.",
  })
  @ApiOkResponse({
    description: "Private browser-playable source MP4 with byte-range support.",
    headers: { "Accept-Ranges": BYTE_RANGE_HEADERS["Accept-Ranges"] },
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 206,
    description: "Requested source byte range.",
    headers: BYTE_RANGE_HEADERS,
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 416,
    description: "The requested byte range cannot be satisfied.",
    headers: UNSATISFIED_RANGE_HEADERS,
    content: {
      "application/json": {
        schema: { $ref: getSchemaPath(ErrorResponseDto) },
      },
    },
  })
  async source(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    try {
      await this.repository.requireProjectAuthorization(projectId);
    } catch (error) {
      this.rethrowAuthorization(error);
    }
    const object = await this.repository.getSourceObject(projectId);
    if (!object)
      throw new NotFoundException({
        code: "SOURCE_NOT_FOUND",
        message: "Ready source was not found.",
      });
    await this.streamObject(
      object.objectKey,
      object.sizeBytes,
      object.filename,
      false,
      range,
      response,
    );
  }

  @Get("pipeline-jobs/:id/result")
  @ApiProduces("video/mp4")
  @ApiHeader({
    name: "Range",
    required: false,
    description: "One RFC 9110 byte range, for example bytes=0-1048575.",
  })
  @ApiOkResponse({
    description: "Ready cut result MP4 attachment.",
    headers: { "Accept-Ranges": BYTE_RANGE_HEADERS["Accept-Ranges"] },
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 206,
    description: "Requested cut-result byte range.",
    headers: BYTE_RANGE_HEADERS,
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 416,
    description: "The requested byte range cannot be satisfied.",
    headers: UNSATISFIED_RANGE_HEADERS,
    content: {
      "application/json": {
        schema: { $ref: getSchemaPath(ErrorResponseDto) },
      },
    },
  })
  async result(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    try {
      await this.repository.requireJobAuthorization(id);
    } catch (error) {
      this.rethrowAuthorization(error);
    }
    const object = await this.repository.getResultObject(id);
    if (!object)
      throw new ConflictException({
        code: "CUT_RESULT_NOT_READY",
        message: "The cut result is not ready.",
      });
    await this.streamObject(
      object.objectKey,
      object.sizeBytes,
      object.filename,
      true,
      range,
      response,
    );
  }

  private async streamObject(
    objectKey: string,
    sizeBytes: bigint,
    filename: string,
    attachment: boolean,
    range: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (range) {
      const status = byteRangeStatus(range, sizeBytes);
      if (status === "invalid") {
        throw new BadRequestException({
          code: "RANGE_INVALID",
          message: "Only one byte range is supported.",
        });
      }
      if (status === "unsatisfiable") {
        this.throwRangeNotSatisfiable(sizeBytes, response);
      }
    }
    if (!this.storage.readObject)
      throw new Error("MEDIA_STORAGE_STREAMING_UNAVAILABLE");
    let stored;
    try {
      stored = await this.storage.readObject(objectKey, range);
    } catch (error) {
      if (error instanceof ObjectRangeNotSatisfiableError) {
        this.throwRangeNotSatisfiable(sizeBytes, response);
      }
      throw error;
    }
    if (!stored)
      throw new NotFoundException({
        code: "MEDIA_OBJECT_NOT_FOUND",
        message: "Media object was not found.",
      });
    response.statusCode = stored.contentRange ? 206 : 200;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", String(stored.contentLength));
    if (stored.contentRange)
      response.setHeader("Content-Range", stored.contentRange);
    if (stored.etag) response.setHeader("ETag", stored.etag);
    if (attachment) {
      const fallback =
        filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "cut.mp4";
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    stored.body.on("error", () => response.destroy());
    stored.body.pipe(response);
  }

  private throwRangeNotSatisfiable(
    sizeBytes: bigint,
    response: ServerResponse,
  ): never {
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Range", `bytes */${sizeBytes}`);
    throw new HttpException(
      {
        code: "RANGE_NOT_SATISFIABLE",
        message: "The requested byte range is not satisfiable.",
      },
      HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
    );
  }

  private rethrowAuthorization(error: unknown): never {
    if (error instanceof SourceAuthorizationRequiredError) {
      throw new HttpException(
        {
          code: "SOURCE_AUTHORIZATION_REQUIRED",
          message:
            "Explicit authorization is required for this source version.",
        },
        HttpStatus.FORBIDDEN,
      );
    }
    throw error;
  }
}

function byteRangeStatus(
  range: string,
  sizeBytes: bigint,
): "satisfiable" | "unsatisfiable" | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return "invalid";

  if (match[1]) {
    const start = BigInt(match[1]);
    if (start >= sizeBytes) return "unsatisfiable";
    if (match[2] && BigInt(match[2]) < start) return "unsatisfiable";
    return "satisfiable";
  }

  return BigInt(match[2]!) === 0n || sizeBytes === 0n
    ? "unsatisfiable"
    : "satisfiable";
}
