import { z } from "zod";

const list = (limit: number) =>
  z
    .string()
    .max(limit * 31)
    .transform((value) =>
      value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    );
const required = (max: number) => z.string().trim().min(1).max(max);

export const profileFormSchema = z
  .object({
    canonicalDisplayName: required(200),
    officialUrl: z.string().trim().url().max(2048),
    primaryLanguage: required(35),
    topicsText: list(100),
    editorialNotes: z.string().max(5000),
    restrictionsText: list(500),
  })
  .superRefine((value, ctx) => {
    if (value.topicsText.length > 30)
      ctx.addIssue({
        code: "custom",
        message: "Не более 30 тем.",
        path: ["topicsText"],
      });
    if (value.restrictionsText.length > 30)
      ctx.addIssue({
        code: "custom",
        message: "Не более 30 ограничений.",
        path: ["restrictionsText"],
      });
  });
export const sourceContextFormSchema = z
  .object({
    creatorProfileId: z.uuid(),
    creatorProfileRevision: z.number().int().positive(),
    sourceTitle: required(500),
    gameOrTopic: required(300),
    audience: required(1000),
    editorialGoal: required(1000),
    language: required(35),
    defaultCta: z.string().max(1000),
    restrictionsText: list(500),
    operatorNotes: z.string().max(5000),
  })
  .superRefine((value, ctx) => {
    if (value.restrictionsText.length > 30)
      ctx.addIssue({
        code: "custom",
        message: "Не более 30 ограничений.",
        path: ["restrictionsText"],
      });
  });
export const promptFormSchema = z
  .object({
    whatHappens: required(5000),
    desiredAngle: required(1000),
    tone: required(500),
    cta: z.string().max(1000),
    restrictionsText: list(500),
  })
  .superRefine((value, ctx) => {
    if (value.restrictionsText.length > 30)
      ctx.addIssue({
        code: "custom",
        message: "Не более 30 ограничений.",
        path: ["restrictionsText"],
      });
  });
export const referenceAuthorizationSchema = z.object({
  basis: required(1000),
  scope: required(1000),
  expiresAt: z.string().datetime().or(z.literal("")),
  externalProviderTransferAllowed: z.boolean(),
  attested: z.literal(true),
});
