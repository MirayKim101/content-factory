import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type EditorialAsset = components["schemas"]["EditorialAssetResponseDto"];
export type EditorialPackage =
  components["schemas"]["EditorialPackageResponseDto"];
export type ProcessingTemplateRevision =
  components["schemas"]["ProcessingTemplateRevisionResponseDto"];
export type SaveEditorialPackage =
  components["schemas"]["SaveEditorialPackageDto"];

const assetSchema: z.ZodType<EditorialAsset> = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  type: z.literal("THUMBNAIL"),
  status: z.enum(["PENDING", "READY", "FAILED_FINAL"]),
  originalFilename: z.string(),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const templateSchema: z.ZodType<ProcessingTemplateRevision> = z.object({
  id: z.uuid(),
  templateId: z.uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  configurationVersion: z.literal("manual-editorial-v1"),
  createdAt: z.iso.datetime(),
});
const packageSchema: z.ZodType<EditorialPackage> = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  pipelineJobId: z.uuid(),
  cutResultArtifact: z.object({
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.string().regex(/^\d+$/),
    sourceId: z.uuid(),
    sourceVersion: z.number().int().positive(),
    recipeVersion: z.string(),
  }),
  revision: z.object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    processingTemplateRevision: templateSchema,
    title: z.string().nullable(),
    description: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    thumbnail: assetSchema.nullable(),
    createdAt: z.iso.datetime(),
  }),
  validation: z.object({
    complete: z.boolean(),
    missingFields: z.array(
      z.enum(["TITLE", "DESCRIPTION", "TAGS", "THUMBNAIL"]),
    ),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class EditorialApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EditorialApiError";
  }
}

export function createEditorialContentApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async listTemplates(): Promise<ProcessingTemplateRevision[]> {
      return request(
        fetchImplementation,
        `${basePath}/processing-templates`,
        {},
        z.object({ items: z.array(templateSchema) }),
      ).then((value) => value.items);
    },
    async createTemplate(
      name: string,
      idempotencyKey: string,
    ): Promise<ProcessingTemplateRevision> {
      return request(
        fetchImplementation,
        `${basePath}/processing-templates`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ name }),
        },
        templateSchema,
      );
    },
    async listProjectPackages(projectId: string): Promise<EditorialPackage[]> {
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/editorial-packages`,
        {},
        z.object({ items: z.array(packageSchema) }),
      ).then((value) => value.items);
    },
    async listThumbnails(projectId: string): Promise<EditorialAsset[]> {
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/editorial-assets/thumbnails`,
        {},
        z.object({ items: z.array(assetSchema) }),
      ).then((value) => value.items);
    },
    thumbnailContentUrl(projectId: string, assetId: string): string {
      return `${basePath}/projects/${encodeURIComponent(projectId)}/editorial-assets/thumbnails/${encodeURIComponent(assetId)}/content`;
    },
    async uploadThumbnail(
      projectId: string,
      file: File,
      idempotencyKey: string,
    ): Promise<EditorialAsset> {
      const body = new FormData();
      body.set("file", file);
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/editorial-assets/thumbnails`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body,
        },
        assetSchema,
      );
    },
    async savePackage(
      jobId: string,
      input: SaveEditorialPackage,
      idempotencyKey: string,
    ): Promise<EditorialPackage> {
      return request(
        fetchImplementation,
        `${basePath}/pipeline-jobs/${encodeURIComponent(jobId)}/editorial-package`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        },
        packageSchema,
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
    throw new EditorialApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new EditorialApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
