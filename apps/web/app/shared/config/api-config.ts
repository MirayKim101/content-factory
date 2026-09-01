import { z } from "zod";

const apiBasePathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]*$/, "Путь API должен быть относительным.")
  .refine(
    (value) => !value.includes("//"),
    "Путь API не может содержать хост.",
  );

export function parseApiBasePath(value: unknown): string {
  return apiBasePathSchema.parse(value);
}
