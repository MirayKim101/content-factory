import { Module } from "@nestjs/common";

import { AppController } from "./app.controller.js";
import { EditorialContentModule } from "./editorial-content/editorial-content.module.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { MediaPipelineModule } from "./media-pipeline/media-pipeline.module.js";
import { AiContentModule } from "./ai-content/ai-content.module.js";

@Module({
  imports: [
    ProjectsModule,
    MediaPipelineModule,
    EditorialContentModule,
    AiContentModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
