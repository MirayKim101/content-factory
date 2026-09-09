import { Inject, Injectable } from "@nestjs/common";

import {
  ASSEMBLY_RENDER_REPOSITORY,
  type AssemblyRenderRepository,
} from "./assembly-render-repository.port.js";
import {
  AssemblyRenderLineageInvalidError,
  AssemblyRenderNotFoundError,
  AssemblyRenderResultNotReadyError,
} from "../domain/assembly-render.js";

@Injectable()
export class GetAssemblyRender {
  constructor(
    @Inject(ASSEMBLY_RENDER_REPOSITORY)
    private readonly repository: AssemblyRenderRepository,
  ) {}
  execute(renderId: string) {
    return this.repository.get(renderId);
  }
}

@Injectable()
export class ListAssemblyRenders {
  constructor(
    @Inject(ASSEMBLY_RENDER_REPOSITORY)
    private readonly repository: AssemblyRenderRepository,
  ) {}
  execute(input: { projectId: string; cursor?: string; limit: number }) {
    return this.repository.listProject(input);
  }
}

@Injectable()
export class GetAssemblyRenderContent {
  constructor(
    @Inject(ASSEMBLY_RENDER_REPOSITORY)
    private readonly repository: AssemblyRenderRepository,
  ) {}
  async execute(renderId: string) {
    const render = await this.repository.get(renderId);
    if (!render) throw new AssemblyRenderNotFoundError();
    if (!render.result || render.job.state !== "READY") {
      throw new AssemblyRenderResultNotReadyError();
    }
    const content = await this.repository.getContent(renderId);
    if (!content) throw new AssemblyRenderLineageInvalidError();
    return content;
  }
}
