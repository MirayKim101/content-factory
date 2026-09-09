import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Put,
  Query,
  Body,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { SourceAuthorizationRequiredError } from "../../projects/domain/source-authorization.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import {
  GetAssemblyRecipe,
  GetAssemblyRecipeRevision,
  ListAssemblyRecipes,
} from "../application/assembly-recipe-queries.js";
import { SaveAssemblyRecipe } from "../application/save-assembly-recipe.js";
import {
  AssemblyRecipeAssetInvalidError,
  AssemblyRecipeAssetNotFoundError,
  AssemblyRecipeAssetRightsError,
  AssemblyRecipeConfigurationError,
  AssemblyRecipeCursorInvalidError,
  AssemblyRecipeCutLineageInvalidError,
  AssemblyRecipeCutNotReadyError,
  AssemblyRecipeIdempotencyConflictError,
  AssemblyRecipeNotFoundError,
  AssemblyRecipePersistenceError,
  AssemblyRecipeProjectNotFoundError,
  AssemblyRecipeRevisionConflictError,
} from "../domain/assembly-recipe.js";
import {
  AssemblyRecipeListQueryDto,
  AssemblyRecipeListResponseDto,
  AssemblyRecipeResponseDto,
  SaveAssemblyRecipeDto,
} from "./assembly-recipe.dto.js";
import { assemblyRecipeResponse } from "./assembly-recipe-response.js";

@ApiTags("editorial-content")
@Controller("api/v1")
export class AssemblyRecipeController {
  constructor(
    private readonly saveRecipe: SaveAssemblyRecipe,
    private readonly getRecipe: GetAssemblyRecipe,
    private readonly getRevision: GetAssemblyRecipeRevision,
    private readonly listRecipes: ListAssemblyRecipes,
  ) {}

  @Put("pipeline-jobs/:jobId/assembly-recipe")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiParam({ name: "jobId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: SaveAssemblyRecipeDto })
  @ApiOkResponse({ type: AssemblyRecipeResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  async put(
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: SaveAssemblyRecipeDto,
  ): Promise<AssemblyRecipeResponseDto> {
    try {
      return assemblyRecipeResponse(
        await this.saveRecipe.execute({
          pipelineJobId: jobId,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
          expectedRevision: body.expectedRevision,
          introAssetId: body.introAssetId ?? null,
          outroAssetId: body.outroAssetId ?? null,
          advertisement: body.advertisement ?? null,
          banners: body.banners,
          cta: body.cta ?? null,
          audioProfileVersion: body.audioProfileVersion,
          encodingProfileVersion: body.encodingProfileVersion,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("pipeline-jobs/:jobId/assembly-recipe")
  @ApiParam({ name: "jobId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: AssemblyRecipeResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async current(
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
  ): Promise<AssemblyRecipeResponseDto> {
    try {
      const value = await this.getRecipe.execute(jobId);
      if (!value) throw new AssemblyRecipeNotFoundError();
      return assemblyRecipeResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("pipeline-jobs/:jobId/assembly-recipe/revisions/:revision")
  @ApiParam({ name: "jobId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "revision", schema: { type: "integer", minimum: 1 } })
  @ApiOkResponse({ type: AssemblyRecipeResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async historical(
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
    @Param("revision", ParseIntPipe) revision: number,
  ): Promise<AssemblyRecipeResponseDto> {
    if (revision < 1) {
      throw new BadRequestException({
        code: "ASSEMBLY_REVISION_INVALID",
        message: "Revision must be a positive integer.",
      });
    }
    try {
      const value = await this.getRevision.execute(jobId, revision);
      if (!value) throw new AssemblyRecipeNotFoundError();
      return assemblyRecipeResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/assembly-recipes")
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", format: "uuid" },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiOkResponse({ type: AssemblyRecipeListResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async project(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query() query: AssemblyRecipeListQueryDto,
  ): Promise<AssemblyRecipeListResponseDto> {
    try {
      const values = await this.listRecipes.execute({
        projectId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit + 1,
      });
      const hasMore = values.length > query.limit;
      const page = values.slice(0, query.limit);
      return {
        items: page.map(assemblyRecipeResponse),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof SourceAuthorizationRequiredError) {
      throw new ForbiddenException({
        code: "SOURCE_AUTHORIZATION_REQUIRED",
        message: "Explicit authorization is required for this source version.",
      });
    }
    if (error instanceof AssemblyRecipeAssetRightsError) {
      throw new ForbiddenException({
        code: "MONTAGE_ASSET_RIGHTS_REQUIRED",
        message: "Usable rights evidence is required for every montage asset.",
      });
    }
    if (error instanceof AssemblyRecipeIdempotencyConflictError) {
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to a different assembly recipe request.",
      });
    }
    if (error instanceof AssemblyRecipeRevisionConflictError) {
      throw new ConflictException({
        code: "ASSEMBLY_REVISION_CONFLICT",
        message: "The assembly recipe changed. Refresh before saving.",
      });
    }
    if (error instanceof AssemblyRecipeCutNotReadyError) {
      throw new ConflictException({
        code: "CUT_RESULT_NOT_READY",
        message: "A READY cut job is required.",
      });
    }
    if (error instanceof AssemblyRecipeCutLineageInvalidError) {
      throw new ConflictException({
        code: "CUT_RESULT_LINEAGE_INVALID",
        message: "The ready cut result lineage is invalid.",
      });
    }
    if (error instanceof AssemblyRecipeAssetInvalidError) {
      throw new ConflictException({
        code: "MONTAGE_ASSET_INVALID",
        message: "A montage asset is not READY or has invalid lineage or kind.",
      });
    }
    if (error instanceof AssemblyRecipeAssetNotFoundError) {
      throw new NotFoundException({
        code: "MONTAGE_ASSET_NOT_FOUND",
        message: "A referenced montage asset was not found.",
      });
    }
    if (
      error instanceof AssemblyRecipeNotFoundError ||
      error instanceof AssemblyRecipeProjectNotFoundError
    ) {
      throw new NotFoundException({
        code:
          error instanceof AssemblyRecipeProjectNotFoundError
            ? "PROJECT_NOT_FOUND"
            : "ASSEMBLY_RECIPE_NOT_FOUND",
        message:
          error instanceof AssemblyRecipeProjectNotFoundError
            ? "Project was not found."
            : "Assembly recipe was not found.",
      });
    }
    if (error instanceof AssemblyRecipeConfigurationError) {
      throw new HttpException(
        {
          code: "ASSEMBLY_RECIPE_INVALID",
          message: error.message,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (error instanceof AssemblyRecipeCursorInvalidError) {
      throw new BadRequestException({
        code: "ASSEMBLY_RECIPE_CURSOR_INVALID",
        message: "Cursor does not belong to this project.",
      });
    }
    if (error instanceof AssemblyRecipePersistenceError) {
      throw new ConflictException({
        code: "ASSEMBLY_RECIPE_LINEAGE_INVALID",
        message: "Stored assembly recipe lineage is invalid.",
      });
    }
    throw error;
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "A valid Idempotency-Key header is required.",
    });
  }
  return value;
}
