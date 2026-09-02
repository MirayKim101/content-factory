import { Module } from "@nestjs/common";

import { AppController } from "./app.controller.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { MediaPipelineModule } from "./media-pipeline/media-pipeline.module.js";

@Module({
  imports: [ProjectsModule, MediaPipelineModule],
  controllers: [AppController],
})
export class AppModule {}
