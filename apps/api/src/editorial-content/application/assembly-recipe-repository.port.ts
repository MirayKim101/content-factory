import type {
  AssemblyRecipeConfiguration,
  AssemblyRecipeView,
} from "../domain/assembly-recipe.js";

export const ASSEMBLY_RECIPE_REPOSITORY = Symbol("ASSEMBLY_RECIPE_REPOSITORY");

export interface AssemblyRecipeRepository {
  save(input: {
    recipeId: string;
    revisionId: string;
    mutationId: string;
    assetReferenceIds: string[];
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    configurationFingerprint: string;
    configuration: AssemblyRecipeConfiguration;
  }): Promise<AssemblyRecipeView>;
  getCurrent(pipelineJobId: string): Promise<AssemblyRecipeView | null>;
  getRevision(
    pipelineJobId: string,
    revision: number,
  ): Promise<AssemblyRecipeView | null>;
  listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<AssemblyRecipeView[]>;
}
