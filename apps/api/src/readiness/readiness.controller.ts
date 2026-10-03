import type { ServerResponse } from "node:http";

import { Controller, Get, Header, Res } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
} from "@nestjs/swagger";

import {
  ReadinessResponseDto,
  ReadinessUnavailableResponseDto,
} from "./readiness.dto.js";
import { ReadinessService } from "./readiness.service.js";

const DEPENDENCIES_UNAVAILABLE = {
  error: {
    code: "DEPENDENCIES_UNAVAILABLE",
    message: "Required dependencies are unavailable.",
  },
} as const;

@Controller("api/v1")
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("readiness")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Check API dependency readiness." })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({ type: ReadinessUnavailableResponseDto })
  async getReadiness(
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<ReadinessResponseDto | ReadinessUnavailableResponseDto> {
    if (await this.readiness.isReady()) return { status: "ready" };
    response.statusCode = 503;
    return DEPENDENCIES_UNAVAILABLE;
  }
}
