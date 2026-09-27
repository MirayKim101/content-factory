import { Module } from "@nestjs/common";

import { ProjectsModule } from "../projects/projects.module.js";
import { TwitchIngestionService } from "./application/twitch-ingestion.service.js";
import { TwitchIngestionController } from "./presentation/twitch-ingestion.controller.js";

@Module({
  imports: [ProjectsModule],
  controllers: [TwitchIngestionController],
  providers: [TwitchIngestionService],
})
export class TwitchIngestionModule {}
