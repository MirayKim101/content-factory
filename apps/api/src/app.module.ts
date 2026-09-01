import { Module } from "@nestjs/common";

import { AppController } from "./app.controller.js";
import { ProjectsModule } from "./projects/projects.module.js";

@Module({
  imports: [ProjectsModule],
  controllers: [AppController],
})
export class AppModule {}
