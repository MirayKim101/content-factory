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
import { GetProject } from "../application/get-project.js";
import {
  CreateProjectUploadDto,
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", uploadOptions),
  )
  @ApiOperation({
    summary: "Create a project by uploading an authorized MP4 source",
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
      originalFilename: file.originalname,
      filePath: file.path,
      idempotencyKey,
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
