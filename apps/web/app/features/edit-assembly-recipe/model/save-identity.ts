import type { SaveAssemblyRecipe } from "~/shared/api/assembly-recipes";
import { assemblyRecipeFingerprint } from "~/features/edit-assembly-recipe/model/active-assembly-recipe-attempt-storage";

export interface AssemblyRecipeSaveAttempt {
  fingerprint: string;
  key: string;
}

export function idempotencyForAssemblyRecipeSave(
  current: AssemblyRecipeSaveAttempt | undefined,
  payload: SaveAssemblyRecipe,
  createKey: () => string,
): AssemblyRecipeSaveAttempt {
  const fingerprint = assemblyRecipeFingerprint(payload);
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: createKey() };
}
