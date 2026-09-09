import { Module } from "@nestjs/common";

import { AppController } from "./app.controller.js";
import { CutsModule } from "./cuts/cuts.module.js";
import { ProjectsModule } from "./projects/projects.module.js";

@Module({
  imports: [ProjectsModule, CutsModule],
  controllers: [AppController],
})
export class AppModule {}
