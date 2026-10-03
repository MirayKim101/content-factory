import { Module } from "@nestjs/common";

import { ReadinessController } from "./readiness.controller.js";
import {
  READINESS_RESOURCE_FACTORY,
  ReadinessResourceFactory,
} from "./readiness.resources.js";
import { ReadinessService } from "./readiness.service.js";

@Module({
  controllers: [ReadinessController],
  providers: [
    ReadinessService,
    ReadinessResourceFactory,
    {
      provide: READINESS_RESOURCE_FACTORY,
      useExisting: ReadinessResourceFactory,
    },
  ],
})
export class ReadinessModule {}
