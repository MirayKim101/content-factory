import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBody,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import { CreateEditorialApproval } from "../application/create-editorial-approval.js";
import {
  GetEditorialReview,
  ListEditorialApprovals,
} from "../application/editorial-approval-queries.js";
import {
  EditorialApprovalAuthorizationError,
  EditorialApprovalCandidateConflictError,
  EditorialApprovalCursorInvalidError,
  EditorialApprovalIdempotencyConflictError,
  EditorialApprovalLineageInvalidError,
  EditorialApprovalUnavailableError,
  EditorialReviewNotFoundError,
} from "../domain/editorial-approval.js";
import {
  CreateEditorialApprovalDto,
  EditorialApprovalListQueryDto,
  EditorialApprovalListResponseDto,
  EditorialApprovalResponseDto,
  EditorialReviewResponseDto,
} from "./editorial-approval.dto.js";
import {
  editorialApprovalResponse,
  editorialReviewResponse,
} from "./editorial-approval-response.js";

@ApiTags("editorial-content")
@ApiExtraModels(ErrorResponseDto)
@Controller("api/v1")
export class EditorialApprovalController {
  constructor(
    @Inject(GetEditorialReview)
    private readonly getReview: GetEditorialReview,
    @Inject(CreateEditorialApproval)
    private readonly createApproval: CreateEditorialApproval,
    @Inject(ListEditorialApprovals)
    private readonly listApprovals: ListEditorialApprovals,
  ) {}

  @Get("pipeline-jobs/:cutJobId/editorial-review")
  @ApiOperation({ summary: "Get one authoritative editorial review candidate" })
  @ApiOkResponse({ type: EditorialReviewResponseDto })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409 })
  async review(
    @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string,
  ): Promise<EditorialReviewResponseDto> {
    try {
      const value = await this.getReview.execute(cutJobId);
      if (!value) throw new EditorialReviewNotFoundError();
      return editorialReviewResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post("assembly-renders/:renderId/editorial-approvals")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Approve one exact editorial and render revision" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateEditorialApprovalDto })
  @ApiResponse({ status: 201, type: EditorialApprovalResponseDto })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409 })
  @ApiResponse({ status: 503 })
  async create(
    @Param("renderId", new ParseUUIDPipe({ version: "4" })) renderId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateEditorialApprovalDto,
  ): Promise<EditorialApprovalResponseDto> {
    try {
      return editorialApprovalResponse(
        await this.createApproval.execute({
          renderId,
          editorialRevision: body.editorialRevision,
          candidateFingerprint: body.candidateFingerprint,
          manualAttentionMs: body.manualAttentionMs,
          attentionMeasurementVersion: body.attentionMeasurementVersion,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/editorial-approvals")
  @ApiOkResponse({ type: EditorialApprovalListResponseDto })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 404 })
  async project(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query() query: EditorialApprovalListQueryDto,
  ): Promise<EditorialApprovalListResponseDto> {
    try {
      const values = await this.listApprovals.execute({
        projectId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit + 1,
      });
      const hasMore = values.length > query.limit;
      const page = values.slice(0, query.limit);
      return {
        items: page.map(editorialApprovalResponse),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof EditorialReviewNotFoundError)
      throw new NotFoundException({
        code: "EDITORIAL_REVIEW_NOT_FOUND",
        message: "The requested editorial review target was not found.",
      });
    if (error instanceof EditorialApprovalIdempotencyConflictError)
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to a different editorial operation.",
      });
    if (error instanceof EditorialApprovalCandidateConflictError)
      throw new ConflictException({
        code: "EDITORIAL_APPROVAL_CANDIDATE_CHANGED",
        message:
          "The editorial review candidate changed. Refresh before approval.",
      });
    if (error instanceof EditorialApprovalAuthorizationError)
      throw new ForbiddenException({
        code: "EDITORIAL_APPROVAL_AUTHORIZATION_REQUIRED",
        message: "Usable source and montage rights are required.",
      });
    if (error instanceof EditorialApprovalLineageInvalidError)
      throw new ConflictException({
        code: "EDITORIAL_APPROVAL_LINEAGE_INVALID",
        message: "Stored editorial approval lineage is invalid.",
      });
    if (error instanceof EditorialApprovalCursorInvalidError)
      throw new BadRequestException({
        code: "EDITORIAL_APPROVAL_CURSOR_INVALID",
        message: "Cursor does not belong to this project.",
      });
    if (error instanceof EditorialApprovalUnavailableError)
      throw new ServiceUnavailableException({
        code: "EDITORIAL_APPROVAL_DISABLED",
        message: "Editorial approval admission is temporarily disabled.",
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
