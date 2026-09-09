import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  ASSEMBLY_RECIPE_REPOSITORY,
  type AssemblyRecipeRepository,
} from "./assembly-recipe-repository.port.js";
import {
  ASSEMBLY_AUDIO_PROFILE,
  ASSEMBLY_ENCODING_PROFILE,
  type AssemblyRecipeConfiguration,
} from "../domain/assembly-recipe.js";

export interface SaveAssemblyRecipeInput extends Omit<
  AssemblyRecipeConfiguration,
  "audioProfileVersion" | "encodingProfileVersion"
> {
  pipelineJobId: string;
  expectedRevision: number;
  idempotencyKey: string;
  audioProfileVersion: typeof ASSEMBLY_AUDIO_PROFILE;
  encodingProfileVersion: typeof ASSEMBLY_ENCODING_PROFILE;
}

@Injectable()
export class SaveAssemblyRecipe {
  constructor(
    @Inject(ASSEMBLY_RECIPE_REPOSITORY)
    private readonly repository: AssemblyRecipeRepository,
  ) {}

  execute(input: SaveAssemblyRecipeInput) {
    const configuration: AssemblyRecipeConfiguration = {
      introAssetId: input.introAssetId ?? null,
      outroAssetId: input.outroAssetId ?? null,
      advertisement: input.advertisement ?? null,
      banners: input.banners ?? [],
      cta: input.cta ?? null,
      audioProfileVersion: input.audioProfileVersion,
      encodingProfileVersion: input.encodingProfileVersion,
    };
    const canonicalRequest = {
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      configuration,
    };
    return this.repository.save({
      recipeId: randomUUID(),
      revisionId: randomUUID(),
      mutationId: randomUUID(),
      assetReferenceIds: Array.from(
        { length: countAssetReferences(configuration) },
        () => randomUUID(),
      ),
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(canonicalRequest),
      configurationFingerprint: fingerprint(configuration),
      configuration,
    });
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function countAssetReferences(value: AssemblyRecipeConfiguration): number {
  return (
    Number(value.introAssetId !== null) +
    Number(value.outroAssetId !== null) +
    Number(value.advertisement !== null) +
    value.banners.length
  );
}
