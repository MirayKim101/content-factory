import { z } from "zod";
import type { components } from "./openapi";

export type Project = components["schemas"]["ProjectResponseDto"];

// Temporary hand-maintained boundary. Replace by OpenAPI generation once the
// authoritative local schema endpoint is available (see task blocker report).
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"]),
  rights: z.object({
    confirmedAt: z.iso.datetime(),
    declarationVersion: z.string(),
  }),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  source: z.object({
    id: z.uuid(),
    status: z.enum(["PENDING", "READY", "FAILED_FINAL"]),
    sourceVersion: z.number().int().positive(),
    originalFilename: z.string(),
    contentType: z.literal("video/mp4"),
    sizeBytes: z.string().regex(/^\d+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  artifact: z.object({
    id: z.uuid(),
    role: z.literal("SOURCE"),
    status: z.enum(["PENDING", "READY", "FAILED_FINAL"]),
    sizeBytes: z.string().regex(/^\d+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.literal("video/mp4"),
    lineageSourceId: z.uuid(),
    lineageSourceVersion: z.number().int().positive(),
    recipeVersion: z.string(),
  }),
});
