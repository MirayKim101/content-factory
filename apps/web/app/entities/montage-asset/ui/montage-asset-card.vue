<script setup lang="ts">
import Card from "primevue/card";
import Tag from "primevue/tag";
import type { MontageAsset } from "~/shared/api/montage-assets";
import { formatDisplayTimecode } from "~/shared/lib/timecode";

const props = defineProps<{
  asset: MontageAsset;
  contentUrl: string;
}>();

const statusLabel = {
  UPLOADING: "Загружается",
  PROBE_PENDING: "Проверяется",
  READY: "Готово",
  FAILED_FINAL: "Ошибка",
} as const;
const kindLabel = {
  ADVERTISEMENT: "Реклама",
  INTRO: "Интро",
  OUTRO: "Аутро",
  BANNER: "Баннер",
} as const;
function formatBytes(raw: string): string {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes)) return raw;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}
function severity(): "success" | "warn" | "danger" | "secondary" {
  if (props.asset.status === "READY") return "success";
  if (props.asset.status === "FAILED_FINAL") return "danger";
  if (props.asset.status === "PROBE_PENDING") return "warn";
  return "secondary";
}
</script>

<template>
  <Card class="montage-card">
    <template #content>
      <div class="montage-card-header">
        <strong class="montage-filename" :title="asset.originalFilename">{{
          asset.originalFilename
        }}</strong>
        <Tag :value="statusLabel[asset.status]" :severity="severity()" />
      </div>
      <p class="montage-meta">
        {{ kindLabel[asset.kind] }} · {{ formatBytes(asset.sizeBytes) }}
        <template v-if="asset.durationMs !== null">
          · {{ formatDisplayTimecode(asset.durationMs) }}
        </template>
        <template v-if="asset.width !== null && asset.height !== null">
          · {{ asset.width }}×{{ asset.height }}
        </template>
      </p>
      <video
        v-if="asset.status === 'READY' && asset.contentType === 'video/mp4'"
        class="montage-preview"
        controls
        preload="metadata"
        :src="contentUrl"
        :aria-label="`Предпросмотр ${asset.originalFilename}`"
      />
      <img
        v-else-if="asset.status === 'READY'"
        class="montage-preview montage-image-preview"
        :src="contentUrl"
        :alt="`Предпросмотр ${asset.originalFilename}`"
      />
      <p
        v-else-if="asset.status === 'FAILED_FINAL'"
        class="montage-error"
        role="alert"
      >
        {{
          asset.failure?.message ??
          asset.probe?.failure?.message ??
          "Файл не прошёл проверку."
        }}
      </p>
      <p v-else class="montage-pending" role="status">
        {{
          asset.status === "UPLOADING"
            ? "Файл принимается сервером…"
            : "Проверяем формат и параметры файла…"
        }}
      </p>
    </template>
  </Card>
</template>

<style scoped>
.montage-card {
  min-width: 0;
}
.montage-card-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.75rem;
}
.montage-filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.montage-meta,
.montage-pending {
  margin: 0.5rem 0;
  color: #4e5d53;
}
.montage-error {
  margin: 0.5rem 0;
  color: #a42626;
}
.montage-preview {
  display: block;
  width: 100%;
  max-height: 13rem;
  border-radius: 0.5rem;
  background: #101411;
  object-fit: contain;
}
.montage-image-preview {
  background: #e6ebe5;
}
</style>
