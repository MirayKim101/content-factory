import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { CreateProjectWithSource } from "../application/create-project-with-source.js";
import { ConfirmSourceAuthorization } from "../application/confirm-source-authorization.js";
import { GetProject } from "../application/get-project.js";
import {
  CreateProjectUploadDto,
  ConfirmSourceAuthorizationDto,
  ErrorResponseDto,
  ProjectResponseDto,
} from "./project.dto.js";
import { toProjectResponse } from "./project-response.js";
import { TempUploadLifecycleInterceptor } from "./temp-upload-lifecycle.interceptor.js";
import { uploadOptions } from "./upload-options.js";

@ApiTags("projects")
@Controller("api/v1/projects")
export class ProjectsController {
  constructor(
    private readonly createProject: CreateProjectWithSource,
    private readonly getProject: GetProject,
    private readonly confirmAuthorization: ConfirmSourceAuthorization,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", uploadOptions),
  )
  @ApiOperation({
    summary: "Create a project by uploading an MP4 source",
  })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "Unique caller key (8-200 ASCII characters) for this logical upload.",
  })
  @ApiBody({ type: CreateProjectUploadDto })
  @ApiCreatedResponse({
    description:
      "Created project, or the existing project in its current PENDING, READY, or FAILED state for an identical idempotent retry.",
    type: ProjectResponseDto,
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: "The key belongs to a different payload.",
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: "Invalid fields, file, multipart body, or idempotency key.",
  })
  @ApiResponse({
    status: 413,
    type: ErrorResponseDto,
    description: "Upload exceeds the configured limit.",
  })
  @ApiResponse({
    status: 415,
    type: ErrorResponseDto,
    description: "The file is not a structurally acceptable MP4.",
  })
  @ApiResponse({
    status: 500,
    type: ErrorResponseDto,
    description: "Persistence or internal finalization failure.",
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: "Object storage upload failed.",
  })
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: CreateProjectUploadDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<ProjectResponseDto> {
    if (!file) {
      throw new BadRequestException({
        code: "FILE_REQUIRED",
        message: "An MP4 file is required.",
      });
    }
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "A valid Idempotency-Key header is required.",
      });
    }
    const project = await this.createProject.execute({
      name: body.name,
      originalFilename: file.originalname,
      filePath: file.path,
      idempotencyKey,
      legacyRightsConfirmed: body.rightsConfirmed === "true",
    });
    return toProjectResponse(project);
  }

  @Put(":id/source/authorization")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Confirm rights for the exact stored source version",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: ConfirmSourceAuthorizationDto })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: "Project not found.",
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: "Malformed body or rightsConfirmed is not literal true.",
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      "Source not ready, tuple mismatch, outdated declaration, or immutable confirmation conflict.",
  })
  async authorizeSource(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ConfirmSourceAuthorizationDto,
    @Headers("x-request-id") inboundRequestId: string | undefined,
  ): Promise<ProjectResponseDto> {
    const project = await this.confirmAuthorization.execute({
      projectId: id,
      sourceVersion: body.sourceVersion,
      sourceSha256: body.sourceSha256,
      declarationVersion: body.declarationVersion,
      requestId: requestId(inboundRequestId),
    });
    return toProjectResponse(project);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get safe source-ingestion status and lineage" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: "Project not found.",
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: "Invalid project UUID.",
  })
  @ApiResponse({
    status: 500,
    type: ErrorResponseDto,
    description: "Internal query failure.",
  })
  async get(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<ProjectResponseDto> {
    const project = await this.getProject.execute(id);
    if (!project) {
      throw new NotFoundException({
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      });
    }
    return toProjectResponse(project);
  }
}

function requestId(inbound: string | undefined): string {
  return inbound && /^[A-Za-z0-9._:-]{8,128}$/.test(inbound)
    ? inbound
    : randomUUID();
}
