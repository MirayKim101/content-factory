import { Module } from "@nestjs/common";

import { AppController } from "./app.controller.js";
import { EditorialContentModule } from "./editorial-content/editorial-content.module.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { MediaPipelineModule } from "./media-pipeline/media-pipeline.module.js";
import { AiContentModule } from "./ai-content/ai-content.module.js";
import { PublishingModule } from "./publishing/publishing.module.js";
import { TwitchIngestionModule } from "./twitch-ingestion/twitch-ingestion.module.js";

@Module({
  imports: [
    ProjectsModule,
    MediaPipelineModule,
    EditorialContentModule,
    AiContentModule,
    PublishingModule,
    TwitchIngestionModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
