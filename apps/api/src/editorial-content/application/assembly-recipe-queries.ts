import { Inject, Injectable } from "@nestjs/common";
import {
  ASSEMBLY_RECIPE_REPOSITORY,
  type AssemblyRecipeRepository,
} from "./assembly-recipe-repository.port.js";

@Injectable()
export class GetAssemblyRecipe {
  constructor(
    @Inject(ASSEMBLY_RECIPE_REPOSITORY)
    private readonly repository: AssemblyRecipeRepository,
  ) {}
  execute(pipelineJobId: string) {
    return this.repository.getCurrent(pipelineJobId);
  }
}

@Injectable()
export class GetAssemblyRecipeRevision {
  constructor(
    @Inject(ASSEMBLY_RECIPE_REPOSITORY)
    private readonly repository: AssemblyRecipeRepository,
  ) {}
  execute(pipelineJobId: string, revision: number) {
    return this.repository.getRevision(pipelineJobId, revision);
  }
}

@Injectable()
export class ListAssemblyRecipes {
  constructor(
    @Inject(ASSEMBLY_RECIPE_REPOSITORY)
    private readonly repository: AssemblyRecipeRepository,
  ) {}
  execute(input: { projectId: string; cursor?: string; limit: number }) {
    return this.repository.listProject(input);
  }
}
