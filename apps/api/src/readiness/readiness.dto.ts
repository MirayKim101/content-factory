import { ApiProperty } from "@nestjs/swagger";

export class ReadinessResponseDto {
  @ApiProperty({ type: String, enum: ["ready"] })
  status!: "ready";
}

class DependencyUnavailableErrorDto {
  @ApiProperty({ type: String, enum: ["DEPENDENCIES_UNAVAILABLE"] })
  code!: "DEPENDENCIES_UNAVAILABLE";

  @ApiProperty({
    type: String,
    example: "Required dependencies are unavailable.",
  })
  message!: "Required dependencies are unavailable.";
}

export class ReadinessUnavailableResponseDto {
  @ApiProperty({ type: DependencyUnavailableErrorDto })
  error!: DependencyUnavailableErrorDto;
}
