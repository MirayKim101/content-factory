import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type AssemblyRecipe = components["schemas"]["AssemblyRecipeResponseDto"];
export type SaveAssemblyRecipe = components["schemas"]["SaveAssemblyRecipeDto"];
export type AssemblyPosition =
  components["schemas"]["AssemblyBannerDto"]["position"];

const uuid = z.uuid();
const position = z.enum([
  "TOP_LEFT",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_RIGHT",
]);
const advertisement = z.object({ assetId: uuid, insertAtMs: z.number().int() });
const banner = z.object({
  clientItemId: z.string().min(1),
  assetId: uuid,
  startMs: z.number().int(),
  endMs: z.number().int(),
  position,
});
const cta = z.object({
  text: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  position,
});
const snapshot = z.object({
  id: uuid,
  kind: z.enum(["ADVERTISEMENT", "INTRO", "OUTRO", "BANNER"]),
  revision: z.number().int().positive(),
  sha256: z.string(),
  sizeBytes: z.string(),
  durationMs: z.number().int().nullable(),
});
const recipeSchema: z.ZodType<AssemblyRecipe> = z.object({
  id: uuid,
  projectId: uuid,
  pipelineJobId: uuid,
  cutResultArtifact: z.object({
    id: uuid,
    sha256: z.string(),
    sizeBytes: z.string(),
    sourceId: uuid,
    sourceVersion: z.number().int().positive(),
    recipeVersion: z.string(),
    durationMs: z.number().int(),
  }),
  revision: z.object({
    id: uuid,
    revision: z.number().int().positive(),
    schemaVersion: z.literal("horizontal-assembly-v1"),
    configurationFingerprint: z.string(),
    configuration: z.object({
      introAssetId: uuid.nullable(),
      outroAssetId: uuid.nullable(),
      advertisement: advertisement.nullable(),
      banners: z.array(banner),
      cta: cta.nullable(),
      audioProfileVersion: z.literal("youtube-stereo-v1"),
      encodingProfileVersion: z.literal("youtube-h264-v1"),
    }),
    assets: z.object({
      intro: snapshot.nullable(),
      outro: snapshot.nullable(),
      advertisement: snapshot.nullable(),
      banners: z.array(snapshot),
    }),
    createdAt: z.iso.datetime(),
  }),
  validation: z.object({ valid: z.literal(true) }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class AssemblyRecipesApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AssemblyRecipesApiError";
  }
}

export function createAssemblyRecipesApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async get(jobId: string): Promise<AssemblyRecipe | undefined> {
      try {
        return await request(
          fetchImplementation,
          `${basePath}/pipeline-jobs/${encodeURIComponent(jobId)}/assembly-recipe`,
          {},
          recipeSchema,
        );
      } catch (error) {
        if (
          error instanceof AssemblyRecipesApiError &&
          error.status === 404 &&
          error.code === "ASSEMBLY_RECIPE_NOT_FOUND"
        )
          return undefined;
        throw error;
      }
    },
    async save(
      jobId: string,
      body: SaveAssemblyRecipe,
      idempotencyKey: string,
    ): Promise<AssemblyRecipe> {
      return request(
        fetchImplementation,
        `${basePath}/pipeline-jobs/${encodeURIComponent(jobId)}/assembly-recipe`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        recipeSchema,
      );
    },
  };
}

async function request<T>(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new AssemblyRecipesApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new AssemblyRecipesApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
