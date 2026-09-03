import { z } from "zod";

const optionalText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .transform((value) => value.trim() || null);

export const editorialPackageFormSchema = z.object({
  title: optionalText(200),
  description: optionalText(5000),
  tagsText: z.string().max(3030),
  processingTemplateRevisionId: z.uuid(),
  thumbnailAssetId: z.uuid().nullable(),
});
export type EditorialPackageForm = z.input<typeof editorialPackageFormSchema>;

export function parseOrderedTags(value: string): string[] | null {
  const tags = value
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : null;
}

export function validateThumbnailFile(file: File): string | undefined {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type))
    return "Выберите JPEG, PNG или WebP.";
  if (file.size > 10 * 1024 * 1024)
    return "Размер обложки не должен превышать 10 МиБ.";
  return undefined;
}
