import { z } from "zod";

import type {
  AssemblyPosition,
  AssemblyRecipe,
  SaveAssemblyRecipe,
} from "~/shared/api/assembly-recipes";
import type { MontageAsset } from "~/shared/api/montage-assets";
import { formatDisplayTimecode } from "~/shared/lib/timecode";

const timeText = z.string().regex(/^\d{2}:\d{2}:\d{2}$/);
const position = z.enum([
  "TOP_LEFT",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_RIGHT",
]);

export interface BannerDraft {
  clientItemId: string;
  assetId: string;
  startText: string;
  endText: string;
  startBaselineText?: string;
  startBaselineMs?: number;
  endBaselineText?: string;
  endBaselineMs?: number;
  position: AssemblyPosition;
}

export interface AssemblyRecipeForm {
  introAssetId: string | null;
  outroAssetId: string | null;
  advertisementAssetId: string | null;
  advertisementInsertAtText: string;
  advertisementInsertAtBaselineText?: string;
  advertisementInsertAtBaselineMs?: number;
  banners: BannerDraft[];
  ctaText: string;
  ctaStartText: string;
  ctaEndText: string;
  ctaStartBaselineText?: string;
  ctaStartBaselineMs?: number;
  ctaEndBaselineText?: string;
  ctaEndBaselineMs?: number;
  ctaPosition: AssemblyPosition;
}

export const positions: Array<{ label: string; value: AssemblyPosition }> = [
  { label: "Слева сверху", value: "TOP_LEFT" },
  { label: "Справа сверху", value: "TOP_RIGHT" },
  { label: "Слева снизу", value: "BOTTOM_LEFT" },
  { label: "Справа снизу", value: "BOTTOM_RIGHT" },
];

const schema = z.object({
  introAssetId: z.uuid().nullable(),
  outroAssetId: z.uuid().nullable(),
  advertisementAssetId: z.uuid().nullable(),
  advertisementInsertAtText: z.union([z.literal(""), timeText]),
  banners: z
    .array(
      z.object({
        clientItemId: z.string().min(1),
        assetId: z.uuid(),
        startText: timeText,
        endText: timeText,
        position,
      }),
    )
    .max(8),
  ctaText: z.string().max(120),
  ctaStartText: z.union([z.literal(""), timeText]),
  ctaEndText: z.union([z.literal(""), timeText]),
  ctaPosition: position,
});

export function emptyAssemblyRecipeForm(): AssemblyRecipeForm {
  return {
    introAssetId: null,
    outroAssetId: null,
    advertisementAssetId: null,
    advertisementInsertAtText: "",
    advertisementInsertAtBaselineText: undefined,
    advertisementInsertAtBaselineMs: undefined,
    banners: [],
    ctaText: "",
    ctaStartText: "",
    ctaEndText: "",
    ctaStartBaselineText: undefined,
    ctaStartBaselineMs: undefined,
    ctaEndBaselineText: undefined,
    ctaEndBaselineMs: undefined,
    ctaPosition: "BOTTOM_LEFT",
  };
}

export function emptyBannerDraft(): BannerDraft {
  return {
    clientItemId: crypto.randomUUID(),
    assetId: "",
    startText: "00:00:00",
    endText: "00:00:10",
    startBaselineText: undefined,
    startBaselineMs: undefined,
    endBaselineText: undefined,
    endBaselineMs: undefined,
    position: "TOP_RIGHT",
  };
}

export function recipeToForm(
  recipe: AssemblyRecipe | undefined,
): AssemblyRecipeForm {
  if (!recipe) return emptyAssemblyRecipeForm();
  const configuration = recipe.revision.configuration;
  const advertisementInsertAtText = configuration.advertisement
    ? formatDisplayTimecode(configuration.advertisement.insertAtMs)
    : "";
  const ctaStartText = configuration.cta
    ? formatDisplayTimecode(configuration.cta.startMs)
    : "";
  const ctaEndText = configuration.cta
    ? formatDisplayTimecode(configuration.cta.endMs)
    : "";
  return {
    introAssetId: configuration.introAssetId,
    outroAssetId: configuration.outroAssetId,
    advertisementAssetId: configuration.advertisement?.assetId ?? null,
    advertisementInsertAtText,
    advertisementInsertAtBaselineText: advertisementInsertAtText || undefined,
    advertisementInsertAtBaselineMs: configuration.advertisement?.insertAtMs,
    banners: configuration.banners.map((item) => ({
      clientItemId: item.clientItemId,
      assetId: item.assetId,
      startText: formatDisplayTimecode(item.startMs),
      endText: formatDisplayTimecode(item.endMs),
      startBaselineText: formatDisplayTimecode(item.startMs),
      startBaselineMs: item.startMs,
      endBaselineText: formatDisplayTimecode(item.endMs),
      endBaselineMs: item.endMs,
      position: item.position,
    })),
    ctaText: configuration.cta?.text ?? "",
    ctaStartText,
    ctaEndText,
    ctaStartBaselineText: ctaStartText || undefined,
    ctaStartBaselineMs: configuration.cta?.startMs,
    ctaEndBaselineText: ctaEndText || undefined,
    ctaEndBaselineMs: configuration.cta?.endMs,
    ctaPosition: configuration.cta?.position ?? "BOTTOM_LEFT",
  };
}

export function parseWholeSecondTime(value: string): number | undefined {
  const parsed = timeText.safeParse(value.trim());
  if (!parsed.success) return undefined;
  const parts = parsed.data.split(":").map(Number);
  const hours = parts[0];
  const minutes = parts[1];
  const seconds = parts[2];
  if (hours === undefined || minutes === undefined || seconds === undefined)
    return undefined;
  if (minutes > 59 || seconds > 59) return undefined;
  const milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function timeValue(
  text: string,
  baselineText: string | undefined,
  baselineMs: number | undefined,
): number | undefined {
  return text.trim() === baselineText && baselineMs !== undefined
    ? baselineMs
    : parseWholeSecondTime(text);
}

export function createAssemblyRecipePayload(
  form: AssemblyRecipeForm,
  expectedRevision: number,
  cutDurationMs: number,
  assets: MontageAsset[],
): { payload?: SaveAssemblyRecipe; error?: string } {
  const parsed = schema.safeParse(form);
  if (!parsed.success)
    return {
      error:
        "Проверьте материалы и время в формате ЧЧ:ММ:СС. У каждого баннера нужны материал, начало и конец.",
    };
  const value = parsed.data;
  const assetIds = new Set(
    assets.filter((asset) => asset.status === "READY").map((asset) => asset.id),
  );
  const available = (id: string | null, kind: MontageAsset["kind"]): boolean =>
    id === null ||
    assets.some(
      (asset) =>
        asset.id === id && asset.status === "READY" && asset.kind === kind,
    );
  if (
    !available(value.introAssetId, "INTRO") ||
    !available(value.outroAssetId, "OUTRO")
  )
    return { error: "Выберите готовые материалы нужного типа." };

  const advertisement = value.advertisementAssetId
    ? (() => {
        const insertAtMs = timeValue(
          value.advertisementInsertAtText,
          form.advertisementInsertAtBaselineText,
          form.advertisementInsertAtBaselineMs,
        );
        if (
          insertAtMs === undefined ||
          insertAtMs <= 0 ||
          insertAtMs >= cutDurationMs ||
          !assetIds.has(value.advertisementAssetId) ||
          !available(value.advertisementAssetId, "ADVERTISEMENT")
        )
          return undefined;
        return { assetId: value.advertisementAssetId, insertAtMs };
      })()
    : null;
  if (value.advertisementAssetId && !advertisement)
    return {
      error: "Реклама должна быть готовой и вставляться внутри границ нарезки.",
    };

  const clientIds = new Set<string>();
  const banners: SaveAssemblyRecipe["banners"] = [];
  for (const [index, item] of value.banners.entries()) {
    const baseline = form.banners[index];
    const startMs = timeValue(
      item.startText,
      baseline?.startBaselineText,
      baseline?.startBaselineMs,
    );
    const endMs = timeValue(
      item.endText,
      baseline?.endBaselineText,
      baseline?.endBaselineMs,
    );
    if (
      startMs === undefined ||
      endMs === undefined ||
      startMs >= endMs ||
      endMs > cutDurationMs ||
      clientIds.has(item.clientItemId) ||
      !assetIds.has(item.assetId) ||
      !available(item.assetId, "BANNER")
    )
      return {
        error:
          "Каждый баннер должен быть готовым, уникальным и находиться внутри границ нарезки.",
      };
    clientIds.add(item.clientItemId);
    banners.push({ ...item, startMs, endMs });
  }

  const ctaRequested = Boolean(
    value.ctaText || value.ctaStartText || value.ctaEndText,
  );
  const cta = ctaRequested
    ? (() => {
        const startMs = timeValue(
          value.ctaStartText,
          form.ctaStartBaselineText,
          form.ctaStartBaselineMs,
        );
        const endMs = timeValue(
          value.ctaEndText,
          form.ctaEndBaselineText,
          form.ctaEndBaselineMs,
        );
        if (
          !value.ctaText.trim() ||
          startMs === undefined ||
          endMs === undefined ||
          startMs >= endMs ||
          endMs > cutDurationMs
        )
          return undefined;
        return {
          text: value.ctaText.trim(),
          startMs,
          endMs,
          position: value.ctaPosition,
        };
      })()
    : null;
  if (ctaRequested && !cta)
    return {
      error: "CTA должен содержать текст и корректный интервал внутри нарезки.",
    };
  return {
    payload: {
      expectedRevision,
      introAssetId: value.introAssetId,
      outroAssetId: value.outroAssetId,
      advertisement,
      banners,
      cta,
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
    },
  };
}
