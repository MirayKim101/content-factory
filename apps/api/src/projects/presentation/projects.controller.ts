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
  UnprocessableEntityException,
  ConflictException,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { CreateProjectWithSource } from "../application/create-project-with-source.js";
import { AttestSourceAuthorization } from "../application/attest-source-authorization.js";
import {
  SourceAuthorizationConflictError,
  SourceNotReadyForAuthorizationError,
  SourceVersionConflictError,
} from "../application/project-repository.port.js";
import { GetProject } from "../application/get-project.js";
import { ListProjects } from "../application/list-projects.js";
import {
  CreateProjectUploadDto,
  AttestSourceAuthorizationDto,
  ErrorResponseDto,
  ListProjectsQueryDto,
  ProjectLibraryPageDto,
  ProjectResponseDto,
} from "./project.dto.js";
import {
  decodeProjectListCursor,
  encodeProjectListCursor,
} from "./project-list-cursor.js";
import {
  toProjectLibraryItemResponse,
  toProjectResponse,
} from "./project-response.js";
import { TempUploadLifecycleInterceptor } from "./temp-upload-lifecycle.interceptor.js";
import { uploadOptions } from "./upload-options.js";
import { normalizeMultipartFilename } from "../../http/multipart-filename.js";

@ApiTags("projects")
@Controller("api/v1/projects")
export class ProjectsController {
  constructor(
    private readonly createProject: CreateProjectWithSource,
    private readonly getProject: GetProject,
    private readonly listProjects: ListProjects,
    private readonly attestAuthorization: AttestSourceAuthorization,
  ) {}

  @Get()
  @ApiOperation({ summary: "List source projects for the media library" })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: String,
    maxLength: 512,
    description: "Opaque cursor returned by the previous page.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
    example: 20,
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"],
  })
  @ApiQuery({
    name: "q",
    required: false,
    type: String,
    maxLength: 200,
    description:
      "Case-insensitive literal project name or original filename search. Control characters are rejected.",
  })
  @ApiOkResponse({ type: ProjectLibraryPageDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: "Invalid cursor, limit, status, or search query.",
  })
  @ApiResponse({
    status: 500,
    type: ErrorResponseDto,
    description: "Internal query failure.",
  })
  async list(
    @Query() query: ListProjectsQueryDto,
  ): Promise<ProjectLibraryPageDto> {
    const page = await this.listProjects.execute({
      limit: query.limit ? Number(query.limit) : 20,
      ...(query.cursor
        ? { cursor: decodeProjectListCursor(query.cursor) }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
    });
    return {
      items: page.items.map(toProjectLibraryItemResponse),
      nextCursor: page.nextCursor
        ? encodeProjectListCursor(page.nextCursor)
        : null,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", uploadOptions),
  )
  @ApiOperation({
    summary:
      "Create a project by uploading an MP4 source for later authorization",
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
    description:
      "Invalid fields, rights, file, multipart body, or idempotency key.",
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
      originalFilename: normalizeMultipartFilename(file.originalname),
      filePath: file.path,
      idempotencyKey,
    });
    return toProjectResponse(project);
  }

  @Put(":id/source-authorization")
  @ApiOperation({ summary: "Explicitly attest the current source version" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: AttestSourceAuthorizationDto })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      "The source version, authorization revision, or source readiness changed.",
  })
  @ApiResponse({
    status: 422,
    type: ErrorResponseDto,
    description:
      "The declaration version or explicit attestation is unsupported.",
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: "The path or request body is invalid.",
  })
  async authorize(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AttestSourceAuthorizationDto,
  ): Promise<ProjectResponseDto> {
    if (
      body.declarationVersion !== "source-authorization-v1" ||
      body.attested !== true
    ) {
      throw new UnprocessableEntityException({
        code: "SOURCE_AUTHORIZATION_DECLARATION_UNSUPPORTED",
        message:
          "The supported source authorization declaration must be explicitly attested.",
      });
    }
    try {
      return toProjectResponse(
        await this.attestAuthorization.execute({
          projectId: id,
          sourceVersion: body.sourceVersion,
          expectedRevision: body.expectedRevision,
          declarationVersion: body.declarationVersion,
        }),
      );
    } catch (error) {
      if (error instanceof SourceVersionConflictError)
        throw new ConflictException({
          code: "SOURCE_VERSION_CONFLICT",
          message: "The source version changed. Refresh before confirming.",
        });
      if (error instanceof SourceAuthorizationConflictError)
        throw new ConflictException({
          code: "SOURCE_AUTHORIZATION_CONFLICT",
          message:
            "The authorization decision changed. Refresh before confirming.",
        });
      if (error instanceof SourceNotReadyForAuthorizationError)
        throw new ConflictException({
          code: "SOURCE_NOT_READY",
          message: "The source is not ready for authorization.",
        });
      throw error;
    }
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
