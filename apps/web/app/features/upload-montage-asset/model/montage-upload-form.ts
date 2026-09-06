import { z } from "zod";

import type { MontageAssetKind } from "~/shared/api/montage-assets";

const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_BANNER_BYTES = 10 * 1024 * 1024;

export const montageKinds: Array<{ label: string; value: MontageAssetKind }> = [
  { label: "Рекламная вставка (MP4)", value: "ADVERTISEMENT" },
  { label: "Интро (MP4)", value: "INTRO" },
  { label: "Аутро (MP4)", value: "OUTRO" },
  { label: "Баннер (JPEG, PNG или WebP)", value: "BANNER" },
];

export interface MontageUploadDraft {
  kind: MontageAssetKind;
  file: File | null;
}

export function validateMontageUpload(
  draft: MontageUploadDraft,
):
  | { success: true; data: { kind: MontageAssetKind; file: File } }
  | { success: false; errors: Record<string, string> } {
  const kind = z
    .enum(["ADVERTISEMENT", "INTRO", "OUTRO", "BANNER"])
    .safeParse(draft.kind);
  if (!kind.success)
    return { success: false, errors: { kind: "Выберите тип материала." } };
  if (!draft.file)
    return { success: false, errors: { file: "Выберите файл." } };
  const isBanner = kind.data === "BANNER";
  const allowed = isBanner
    ? ["image/jpeg", "image/png", "image/webp"]
    : ["video/mp4"];
  if (!allowed.includes(draft.file.type)) {
    return {
      success: false,
      errors: {
        file: isBanner
          ? "Для баннера подойдёт JPEG, PNG или WebP."
          : "Для этого материала нужен MP4-файл.",
      },
    };
  }
  const limit = isBanner ? MAX_BANNER_BYTES : MAX_VIDEO_BYTES;
  if (draft.file.size > limit) {
    return {
      success: false,
      errors: {
        file: `Размер файла больше допустимого (${isBanner ? "10 МБ" : "256 МБ"}).`,
      },
    };
  }
  return { success: true, data: { kind: kind.data, file: draft.file } };
}
