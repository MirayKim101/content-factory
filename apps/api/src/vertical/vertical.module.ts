import { Module } from "@nestjs/common";

import { ProjectsModule } from "../projects/projects.module.js";
import { VerticalController } from "./vertical.controller.js";
import {
  BullMqVerticalDispatch,
  VERTICAL_DISPATCH,
} from "./vertical-dispatch.js";
import { VerticalService } from "./vertical.service.js";

@Module({
  imports: [ProjectsModule],
  controllers: [VerticalController],
  providers: [
    VerticalService,
    BullMqVerticalDispatch,
    { provide: VERTICAL_DISPATCH, useExisting: BullMqVerticalDispatch },
  ],
})
export class VerticalModule {}
