import { z } from "zod";
import type { components } from "./openapi";

export type Project = components["schemas"]["ProjectResponseDto"];
export type LibraryPage = components["schemas"]["ProjectLibraryPageDto"];

const authorizationSchema = z.object({
  sourceVersion: z.number().int().positive(),
  status: z.enum(["NOT_REVIEWED", "CLEARED"]),
  basis: z.enum(["LEGACY_ATTESTATION", "OPERATOR_ATTESTATION"]).optional(),
  declarationVersion: z.string().optional(),
  decidedAt: z.iso.datetime().optional(),
  revision: z.number().int().positive(),
});

export const libraryPageSchema: z.ZodType<LibraryPage> = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"]),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      source: z.object({
        id: z.uuid(),
        status: z.enum(["PENDING", "READY", "FAILED_FINAL"]),
        sourceVersion: z.number().int().positive(),
        addedAt: z.iso.datetime(),
        originalFilename: z.string(),
        contentType: z.string(),
        sizeBytes: z.string().regex(/^\d+$/),
        durationMs: z.number().int().nonnegative().optional(),
        probeState: z
          .enum(["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"])
          .optional(),
        authorization: authorizationSchema,
      }),
      cutJobCounts: z.object({
        total: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      }),
    }),
  ),
  nextCursor: z.string().nullable(),
});

// Temporary hand-maintained boundary. Replace by OpenAPI generation once the
// authoritative local schema endpoint is available (see task blocker report).
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"]),
  rights: z
    .object({
      confirmedAt: z.iso.datetime(),
      declarationVersion: z.string(),
    })
    .nullable(),
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
    durationMs: z.number().int().nonnegative().optional(),
    probeState: z
      .enum(["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"])
      .optional(),
    probeFailure: z
      .object({ code: z.string(), message: z.string() })
      .optional(),
    authorization: authorizationSchema,
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
