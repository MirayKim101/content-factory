import type { ServerResponse } from "node:http";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { ObjectRangeNotSatisfiableError } from "../../projects/application/object-storage.port.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import { SecureDiskStorage } from "../../projects/presentation/secure-disk-storage.js";
import { TempUploadLifecycleInterceptor } from "../../projects/presentation/temp-upload-lifecycle.interceptor.js";
import {
  AiContentIdempotencyConflictError,
  AiContentPersistenceConflictError,
  AiContentRevisionConflictError,
  CREATOR_CONTEXT_REPOSITORY,
  CreatorProfileNotFoundError,
  CreatorProfileUrlConflictError,
  CreatorReferenceNotFoundError,
  CreatorReferenceSelectionError,
  CutPromptLineageError,
  SourceContextLineageError,
  type CreatorContextRepository,
  type PageInput,
} from "../application/creator-context-repository.port.js";
import {
  CreatorContextService,
  CREATOR_REFERENCE_MAX_BYTES,
} from "../application/creator-context.service.js";
import {
  CREATOR_CONTEXT_STORAGE,
  type CreatorContextStorage,
} from "../application/creator-context-storage.port.js";
import {
  CreatorContextError,
  decodeScopedCursor,
} from "../domain/creator-context.js";
import { normalizeMultipartFilename } from "../../http/multipart-filename.js";
import { AiContextAdmissionInterceptor } from "./ai-context-admission.interceptor.js";
import {
  AuthorizationDetailResponseDto,
  CreatorProfileDetailResponseDto,
  CreatorProfileListResponseDto,
  CreatorProfileRevisionInputDto,
  CreatorProfileRevisionListResponseDto,
  CreatorProfileRevisionResponseDto,
  CreatorReferenceAssetListResponseDto,
  CreatorReferenceAssetResponseDto,
  CreatorReferenceUploadDto,
  CutEditorialPromptDetailResponseDto,
  CutEditorialPromptRevisionListResponseDto,
  CutEditorialPromptRevisionResponseDto,
  PutCutEditorialPromptDto,
  PutSourceEditorialContextDto,
  SetDefaultCreatorReferenceDto,
  SourceEditorialContextDetailResponseDto,
  SourceEditorialContextRevisionListResponseDto,
  SourceEditorialContextRevisionResponseDto,
  UpdateCreatorProfileDto,
  UpdateCreatorReferenceAuthorizationDto,
} from "./creator-context.dto.js";
import {
  authorizationDetailResponse,
  cutPromptDetailResponse,
  cutPromptRevisionResponse,
  profileDetailResponse,
  profileRevisionResponse,
  profileSummaryResponse,
  referenceAssetResponse,
  sourceContextDetailResponse,
  sourceContextRevisionResponse,
} from "./creator-context-response.js";

const uuidPipe = new ParseUUIDPipe({ version: "4" });
const uuidSchema = { type: "string", format: "uuid" } as const;
const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const creatorProfileConflictSchema = {
  type: "object" as const,
  required: ["error"],
  properties: {
    error: {
      type: "object" as const,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        existingProfileId: { type: "string", format: "uuid" },
      },
    },
  },
};

@ApiTags("ai-content-context")
@ApiResponse({ status: 400, type: ErrorResponseDto })
@Controller()
export class CreatorContextController {
  constructor(
    @Inject(CreatorContextService)
    private readonly service: CreatorContextService,
    @Inject(CREATOR_CONTEXT_REPOSITORY)
    private readonly repository: CreatorContextRepository,
    @Inject(CREATOR_CONTEXT_STORAGE)
    private readonly storage: CreatorContextStorage,
  ) {}

  @Post("api/v1/creator-profiles")
  @HttpCode(201)
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreatorProfileRevisionInputDto })
  @ApiCreatedResponse({ type: CreatorProfileDetailResponseDto })
  @ApiResponse({ status: 409, schema: creatorProfileConflictSchema })
  async createProfile(
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreatorProfileRevisionInputDto,
  ): Promise<CreatorProfileDetailResponseDto> {
    try {
      return profileDetailResponse(
        await this.service.createProfile({
          idempotencyKey: requireIdempotencyKey(key),
          editableRevision: body,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Put("api/v1/creator-profiles/:profileId")
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: UpdateCreatorProfileDto })
  @ApiOkResponse({ type: CreatorProfileDetailResponseDto })
  @ApiResponse({ status: 409, schema: creatorProfileConflictSchema })
  async updateProfile(
    @Param("profileId", uuidPipe) profileId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: UpdateCreatorProfileDto,
  ): Promise<CreatorProfileDetailResponseDto> {
    try {
      const { expectedRevision, ...editableRevision } = body;
      return profileDetailResponse(
        await this.service.updateProfile({
          profileId,
          expectedRevision,
          editableRevision,
          idempotencyKey: requireIdempotencyKey(key),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/creator-profiles")
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: CreatorProfileListResponseDto })
  async listProfiles(
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<CreatorProfileListResponseDto> {
    try {
      const result = await this.repository.listProfiles(
        pageInput(cursor, limit, "creator-profiles"),
      );
      return {
        items: result.items.map(profileSummaryResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/creator-profiles/:profileId")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiOkResponse({ type: CreatorProfileDetailResponseDto })
  async getProfile(
    @Param("profileId", uuidPipe) profileId: string,
  ): Promise<CreatorProfileDetailResponseDto> {
    const found = await this.repository.getProfile(profileId);
    if (!found) throw profileNotFound();
    return profileDetailResponse(found);
  }

  @Get("api/v1/creator-profiles/:profileId/revisions")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiOkResponse({ type: CreatorProfileRevisionListResponseDto })
  async listProfileRevisions(
    @Param("profileId", uuidPipe) profileId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<CreatorProfileRevisionListResponseDto> {
    try {
      const scope = `creator-profile:${profileId}:revisions`;
      const result = await this.repository.listProfileRevisions(
        profileId,
        pageInput(cursor, limit, scope),
      );
      return {
        items: result.items.map(profileRevisionResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/creator-profiles/:profileId/revisions/:revision")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiParam({ name: "revision", schema: positiveIntegerSchema })
  @ApiOkResponse({ type: CreatorProfileRevisionResponseDto })
  async getProfileRevision(
    @Param("profileId", uuidPipe) profileId: string,
    @Param("revision") rawRevision: string,
  ): Promise<CreatorProfileRevisionResponseDto> {
    const revision = positiveRevision(rawRevision);
    const found = await this.repository.getProfile(profileId, revision);
    if (!found) throw profileNotFound();
    return profileRevisionResponse(found.revision);
  }

  @Post("api/v1/creator-profiles/:profileId/reference-assets")
  @HttpCode(201)
  @UseInterceptors(
    AiContextAdmissionInterceptor,
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", {
      storage: new SecureDiskStorage(),
      limits: {
        fileSize: CREATOR_REFERENCE_MAX_BYTES,
        files: 1,
        fields: 0,
        parts: 2,
      },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreatorReferenceUploadDto })
  @ApiCreatedResponse({ type: CreatorReferenceAssetResponseDto })
  async uploadReference(
    @Param("profileId", uuidPipe) profileId: string,
    @Headers("idempotency-key") key: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<CreatorReferenceAssetResponseDto> {
    if (!file)
      throw new BadRequestException({
        code: "CREATOR_REFERENCE_REQUIRED",
        message: "One reference image is required.",
      });
    try {
      return referenceAssetResponse(
        await this.service.uploadReference({
          creatorProfileId: profileId,
          idempotencyKey: requireIdempotencyKey(key),
          originalFilename: normalizeMultipartFilename(file.originalname),
          declaredContentType: file.mimetype,
          filePath: file.path,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/creator-profiles/:profileId/reference-assets")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiOkResponse({ type: CreatorReferenceAssetListResponseDto })
  async listReferences(
    @Param("profileId", uuidPipe) profileId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<CreatorReferenceAssetListResponseDto> {
    try {
      const scope = `creator-profile:${profileId}:references`;
      const result = await this.repository.listReferences(
        profileId,
        pageInput(cursor, limit, scope),
      );
      return {
        items: result.items.map(referenceAssetResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/creator-profiles/:profileId/reference-assets/:assetId/content")
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiParam({ name: "assetId", schema: uuidSchema })
  @ApiHeader({ name: "Range", required: false })
  @ApiResponse({ status: 200, description: "Private reference image bytes." })
  @ApiResponse({ status: 206, description: "One bounded byte range." })
  @ApiResponse({ status: 416, type: ErrorResponseDto })
  async referenceContent(
    @Param("profileId", uuidPipe) profileId: string,
    @Param("assetId", uuidPipe) assetId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    try {
      if (
        range &&
        (!/^bytes=(\d*)-(\d*)$/.test(range) ||
          range === "bytes=-" ||
          range.length > 100)
      )
        throw new CreatorContextError(
          "RANGE_INVALID",
          "Only one byte range is supported.",
          400,
        );
      const found = await this.repository.getReference(profileId, assetId);
      if (!found) throw new CreatorReferenceNotFoundError();
      let stored;
      try {
        stored = await this.storage.readObject(found.objectKey, range);
      } catch (error) {
        if (error instanceof ObjectRangeNotSatisfiableError) {
          response.setHeader(
            "Content-Range",
            `bytes */${found.asset.sizeBytes}`,
          );
          throw new CreatorContextError(
            "RANGE_NOT_SATISFIABLE",
            "Requested range is not satisfiable.",
            416,
          );
        }
        throw error;
      }
      if (!stored)
        throw new CreatorContextError(
          "CREATOR_REFERENCE_CONTENT_MISSING",
          "Reference image content is unavailable.",
          404,
        );
      response.statusCode = stored.contentRange ? 206 : 200;
      response.setHeader("Content-Type", found.asset.contentType);
      response.setHeader("Content-Length", String(stored.contentLength));
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Content-Disposition",
        `inline; filename="creator-reference.${extension(found.asset.contentType)}"`,
      );
      if (stored.contentRange)
        response.setHeader("Content-Range", stored.contentRange);
      stored.body.on("error", () => response.destroy());
      response.once("close", () => stored.body.destroy());
      stored.body.pipe(response);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Put(
    "api/v1/creator-profiles/:profileId/reference-assets/:assetId/authorization",
  )
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiParam({ name: "assetId", schema: uuidSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: UpdateCreatorReferenceAuthorizationDto })
  @ApiOkResponse({ type: AuthorizationDetailResponseDto })
  async updateAuthorization(
    @Param("profileId", uuidPipe) profileId: string,
    @Param("assetId", uuidPipe) assetId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: UpdateCreatorReferenceAuthorizationDto,
  ): Promise<AuthorizationDetailResponseDto> {
    try {
      return authorizationDetailResponse(
        await this.service.updateAuthorization({
          creatorProfileId: profileId,
          assetId,
          ...body,
          idempotencyKey: requireIdempotencyKey(key),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get(
    "api/v1/creator-profiles/:profileId/reference-assets/:assetId/authorization",
  )
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiParam({ name: "assetId", schema: uuidSchema })
  @ApiOkResponse({ type: AuthorizationDetailResponseDto })
  async getAuthorization(
    @Param("profileId", uuidPipe) profileId: string,
    @Param("assetId", uuidPipe) assetId: string,
  ): Promise<AuthorizationDetailResponseDto> {
    const found = await this.repository.getAuthorization(profileId, assetId);
    if (!found) throw referenceNotFound();
    return authorizationDetailResponse(found);
  }

  @Put("api/v1/creator-profiles/:profileId/default-reference")
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiParam({ name: "profileId", schema: uuidSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: SetDefaultCreatorReferenceDto })
  @ApiOkResponse({ type: CreatorProfileDetailResponseDto })
  async setDefaultReference(
    @Param("profileId", uuidPipe) profileId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: SetDefaultCreatorReferenceDto,
  ): Promise<CreatorProfileDetailResponseDto> {
    try {
      const selection = defaultSelection(body);
      return profileDetailResponse(
        await this.service.setDefaultReference({
          profileId,
          expectedProfileRevision: body.expectedProfileRevision,
          selection,
          idempotencyKey: requireIdempotencyKey(key),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Put(
    "api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context",
  )
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiParam({ name: "projectId", schema: uuidSchema })
  @ApiParam({ name: "sourceId", schema: uuidSchema })
  @ApiParam({ name: "sourceVersion", schema: positiveIntegerSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: PutSourceEditorialContextDto })
  @ApiOkResponse({ type: SourceEditorialContextDetailResponseDto })
  async putSourceContext(
    @Param("projectId", uuidPipe) projectId: string,
    @Param("sourceId", uuidPipe) sourceId: string,
    @Param("sourceVersion") rawSourceVersion: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: PutSourceEditorialContextDto,
  ): Promise<SourceEditorialContextDetailResponseDto> {
    const sourceVersion = positiveRevision(rawSourceVersion);
    try {
      const { expectedRevision, ...editableRevision } = body;
      return sourceContextDetailResponse(
        await this.service.putSourceContext({
          projectId,
          sourceId,
          sourceVersion,
          expectedRevision,
          editableRevision,
          idempotencyKey: requireIdempotencyKey(key),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get(
    "api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context",
  )
  @ApiParam({ name: "projectId", schema: uuidSchema })
  @ApiParam({ name: "sourceId", schema: uuidSchema })
  @ApiParam({ name: "sourceVersion", schema: positiveIntegerSchema })
  @ApiOkResponse({ type: SourceEditorialContextDetailResponseDto })
  async getSourceContext(
    @Param("projectId", uuidPipe) projectId: string,
    @Param("sourceId", uuidPipe) sourceId: string,
    @Param("sourceVersion") rawSourceVersion: string,
  ): Promise<SourceEditorialContextDetailResponseDto> {
    const sourceVersion = positiveRevision(rawSourceVersion);
    const found = await this.repository.getSourceContext(
      projectId,
      sourceId,
      sourceVersion,
    );
    if (!found) throw sourceContextNotFound();
    return sourceContextDetailResponse(found);
  }

  @Get(
    "api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context/revisions",
  )
  @ApiParam({ name: "projectId", schema: uuidSchema })
  @ApiParam({ name: "sourceId", schema: uuidSchema })
  @ApiParam({ name: "sourceVersion", schema: positiveIntegerSchema })
  @ApiOkResponse({ type: SourceEditorialContextRevisionListResponseDto })
  async listSourceContextRevisions(
    @Param("projectId", uuidPipe) projectId: string,
    @Param("sourceId", uuidPipe) sourceId: string,
    @Param("sourceVersion") rawSourceVersion: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<SourceEditorialContextRevisionListResponseDto> {
    const sourceVersion = positiveRevision(rawSourceVersion);
    try {
      const scope = `source-context:${projectId}:${sourceId}:${sourceVersion}`;
      const result = await this.repository.listSourceContextRevisions(
        projectId,
        sourceId,
        sourceVersion,
        pageInput(cursor, limit, scope),
      );
      return {
        items: result.items.map(sourceContextRevisionResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get(
    "api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context/revisions/:revision",
  )
  @ApiParam({ name: "projectId", schema: uuidSchema })
  @ApiParam({ name: "sourceId", schema: uuidSchema })
  @ApiParam({ name: "sourceVersion", schema: positiveIntegerSchema })
  @ApiParam({ name: "revision", schema: positiveIntegerSchema })
  @ApiOkResponse({ type: SourceEditorialContextRevisionResponseDto })
  async getSourceContextRevision(
    @Param("projectId", uuidPipe) projectId: string,
    @Param("sourceId", uuidPipe) sourceId: string,
    @Param("sourceVersion") rawSourceVersion: string,
    @Param("revision") rawRevision: string,
  ): Promise<SourceEditorialContextRevisionResponseDto> {
    const found = await this.repository.getSourceContext(
      projectId,
      sourceId,
      positiveRevision(rawSourceVersion),
      positiveRevision(rawRevision),
    );
    if (!found) throw sourceContextNotFound();
    return sourceContextRevisionResponse(found.revision);
  }

  @Put("api/v1/pipeline-jobs/:cutJobId/editorial-prompt")
  @UseInterceptors(AiContextAdmissionInterceptor)
  @ApiParam({ name: "cutJobId", schema: uuidSchema })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: PutCutEditorialPromptDto })
  @ApiOkResponse({ type: CutEditorialPromptDetailResponseDto })
  async putCutPrompt(
    @Param("cutJobId", uuidPipe) cutJobId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: PutCutEditorialPromptDto,
  ): Promise<CutEditorialPromptDetailResponseDto> {
    try {
      const { expectedRevision, ...editableRevision } = body;
      return cutPromptDetailResponse(
        await this.service.putCutPrompt({
          cutPipelineJobId: cutJobId,
          expectedRevision,
          editableRevision,
          idempotencyKey: requireIdempotencyKey(key),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/pipeline-jobs/:cutJobId/editorial-prompt")
  @ApiParam({ name: "cutJobId", schema: uuidSchema })
  @ApiOkResponse({ type: CutEditorialPromptDetailResponseDto })
  async getCutPrompt(
    @Param("cutJobId", uuidPipe) cutJobId: string,
  ): Promise<CutEditorialPromptDetailResponseDto> {
    const found = await this.repository.getCutPrompt(cutJobId);
    if (!found) throw cutPromptNotFound();
    return cutPromptDetailResponse(found);
  }

  @Get("api/v1/pipeline-jobs/:cutJobId/editorial-prompt/revisions")
  @ApiParam({ name: "cutJobId", schema: uuidSchema })
  @ApiOkResponse({ type: CutEditorialPromptRevisionListResponseDto })
  async listCutPromptRevisions(
    @Param("cutJobId", uuidPipe) cutJobId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<CutEditorialPromptRevisionListResponseDto> {
    try {
      const scope = `cut-prompt:${cutJobId}`;
      const result = await this.repository.listCutPromptRevisions(
        cutJobId,
        pageInput(cursor, limit, scope),
      );
      return {
        items: result.items.map(cutPromptRevisionResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("api/v1/pipeline-jobs/:cutJobId/editorial-prompt/revisions/:revision")
  @ApiParam({ name: "cutJobId", schema: uuidSchema })
  @ApiParam({ name: "revision", schema: positiveIntegerSchema })
  @ApiOkResponse({ type: CutEditorialPromptRevisionResponseDto })
  async getCutPromptRevision(
    @Param("cutJobId", uuidPipe) cutJobId: string,
    @Param("revision") rawRevision: string,
  ): Promise<CutEditorialPromptRevisionResponseDto> {
    const found = await this.repository.getCutPrompt(
      cutJobId,
      positiveRevision(rawRevision),
    );
    if (!found) throw cutPromptNotFound();
    return cutPromptRevisionResponse(found.revision);
  }

  private rethrow(error: unknown): never {
    if (error instanceof CreatorContextError)
      throw new HttpException(
        { code: error.code, message: error.message, ...error.safeDetails },
        error.httpStatus,
      );
    if (error instanceof AiContentIdempotencyConflictError)
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to another creator-context operation.",
      });
    if (error instanceof CreatorProfileUrlConflictError)
      throw new ConflictException({
        code: "CREATOR_PROFILE_OFFICIAL_URL_CONFLICT",
        message: "This official URL is already assigned to another profile.",
        existingProfileId: error.existingProfileId,
      });
    if (error instanceof CreatorProfileNotFoundError) throw profileNotFound();
    if (error instanceof CreatorReferenceNotFoundError)
      throw referenceNotFound();
    if (error instanceof AiContentRevisionConflictError)
      throw new ConflictException({
        code: "AI_CONTEXT_REVISION_CONFLICT",
        message: "This resource changed. Reload before saving.",
      });
    if (error instanceof CreatorReferenceSelectionError)
      throw new ConflictException({
        code: error.code,
        message:
          "The selected reference authorization is not currently usable.",
      });
    if (error instanceof SourceContextLineageError)
      throw new ConflictException({
        code: "SOURCE_EDITORIAL_CONTEXT_LINEAGE_INVALID",
        message: "The exact authorized source/profile lineage is not usable.",
      });
    if (error instanceof CutPromptLineageError)
      throw new ConflictException({
        code: "CUT_EDITORIAL_PROMPT_LINEAGE_INVALID",
        message: "The exact READY cut/source-context lineage is not usable.",
      });
    if (error instanceof AiContentPersistenceConflictError)
      throw new ConflictException({
        code: "AI_CONTEXT_STATE_INVALID",
        message: "Creator-context state could not be resolved safely.",
      });
    throw error;
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value))
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "A valid Idempotency-Key header is required.",
    });
  return value;
}

function positiveRevision(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647)
    throw new BadRequestException({
      code: "REVISION_INVALID",
      message: "Revision must be a positive integer.",
    });
  return result;
}

function pageInput(
  cursor: string | undefined,
  rawLimit: string | undefined,
  scope: string,
): PageInput {
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new BadRequestException({
      code: "PAGINATION_INVALID",
      message: "Pagination limit must be between 1 and 100.",
    });
  const decoded = decodeScopedCursor(cursor, scope);
  return { limit, scope, ...(decoded ? { cursor: decoded } : {}) };
}

function defaultSelection(body: SetDefaultCreatorReferenceDto) {
  if (body.action === "CLEAR") {
    if (
      body.assetId !== undefined ||
      body.authorizationRevisionId !== undefined ||
      body.authorizationRevision !== undefined
    )
      throw new BadRequestException({
        code: "DEFAULT_REFERENCE_SELECTION_INVALID",
        message: "CLEAR must not include a reference selection.",
      });
    return { action: "CLEAR" } as const;
  }
  if (
    !body.assetId ||
    !body.authorizationRevisionId ||
    body.authorizationRevision === undefined
  )
    throw new BadRequestException({
      code: "DEFAULT_REFERENCE_SELECTION_INVALID",
      message: "SET requires an exact asset and authorization revision.",
    });
  return {
    action: "SET" as const,
    assetId: body.assetId,
    authorizationRevisionId: body.authorizationRevisionId,
    authorizationRevision: body.authorizationRevision,
  };
}

function profileNotFound(): NotFoundException {
  return new NotFoundException({
    code: "CREATOR_PROFILE_NOT_FOUND",
    message: "Creator profile was not found.",
  });
}

function referenceNotFound(): NotFoundException {
  return new NotFoundException({
    code: "CREATOR_REFERENCE_NOT_FOUND",
    message: "Reference image was not found for this profile.",
  });
}

function sourceContextNotFound(): NotFoundException {
  return new NotFoundException({
    code: "SOURCE_EDITORIAL_CONTEXT_NOT_FOUND",
    message: "Source editorial context was not found.",
  });
}

function cutPromptNotFound(): NotFoundException {
  return new NotFoundException({
    code: "CUT_EDITORIAL_PROMPT_NOT_FOUND",
    message: "Cut editorial prompt was not found.",
  });
}

function extension(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
}
