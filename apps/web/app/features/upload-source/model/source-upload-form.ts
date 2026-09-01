import { z } from "zod";

const acceptedMimeTypes = new Set(["video/mp4", "application/mp4"]);
export const sourceUploadFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Укажи название проекта.")
    .max(200, "Название должно быть не длиннее 200 символов."),
  rightsConfirmed: z.literal(true, {
    error: "Нужно подтвердить права на видео.",
  }),
  file: z
    .instanceof(File, { error: "Выбери MP4-файл." })
    .refine((file) => file.size > 0, "Файл не должен быть пустым.")
    .refine(
      (file) =>
        acceptedMimeTypes.has(file.type) ||
        file.name.toLowerCase().endsWith(".mp4"),
      "Можно загрузить только MP4-файл.",
    ),
});
export type SourceUploadForm = z.infer<typeof sourceUploadFormSchema>;
export type SourceUploadFormDraft = {
  name: string;
  rightsConfirmed: boolean;
  file: File | null;
};
export function validateSourceUploadForm(
  draft: SourceUploadFormDraft,
):
  | { success: true; data: SourceUploadForm }
  | { success: false; errors: Record<string, string> } {
  const result = sourceUploadFormSchema.safeParse(draft);
  if (result.success) return result;
  const errors = Object.fromEntries(
    result.error.issues.map((issue) => [
      String(issue.path[0] ?? "form"),
      issue.message,
    ]),
  );
  return { success: false, errors };
}
