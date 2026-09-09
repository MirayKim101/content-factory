<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { ref } from "vue";

import { useManualCut } from "~/features/manual-cut/model/use-manual-cut";
import { formatTimecode } from "~/features/manual-cut/model/timecode";
import { createCutsApi } from "~/shared/api/cuts";

const props = defineProps<{ projectId: string }>();
const config = useRuntimeConfig();
const api = createCutsApi({ apiBasePath: config.public.apiBasePath });
const player = ref<HTMLVideoElement | null>(null);
const cut = useManualCut(props.projectId, api);

function setPoint(side: "start" | "end"): void {
  if (player.value) cut.setFromPlayer(side, player.value.currentTime);
}
const stateLabels: Record<string, string> = {
  QUEUED: "Ожидает запуска",
  RUNNING: "Обрабатывается",
  FAILED_RETRYABLE: "Ожидает повторной попытки",
  SUCCEEDED: "Готов",
  FAILED_FINAL: "Завершён с ошибкой",
};
const stageLabels: Record<string, string> = {
  QUEUED: "в очереди",
  ADMISSION: "проверяем свободное место",
  CLAIMED: "подготовка",
  SOURCE_DOWNLOAD: "загрузка исходника",
  ENCODING: "точная нарезка",
  OUTPUT_UPLOAD: "сохранение результата",
  RETRY_WAIT: "ожидание повтора",
  COMPLETED: "готово",
  FAILED: "ошибка",
};
function stateLabel(value: string): string {
  return stateLabels[value] ?? "Состояние обновляется";
}
function stageLabel(value: string): string {
  return stageLabels[value] ?? "обработка";
}
function queueReasonLabel(value: string): string {
  return value === "SCRATCH_CAPACITY"
    ? "ожидаем свободное место для видео"
    : "ожидаем доступный ресурс";
}
</script>

<template>
  <section class="manual-cut" aria-labelledby="manual-cut-title">
    <h3 id="manual-cut-title">Ручная нарезка</h3>
    <video
      ref="player"
      controls
      preload="metadata"
      :src="api.sourceUrl(projectId)"
    >
      Браузер не поддерживает видео.
    </video>
    <form class="cut-form" @submit.prevent="cut.submit">
      <label for="cut-start">Начало</label>
      <InputText
        id="cut-start"
        v-model="cut.start.value"
        placeholder="00:00:00.000"
      />
      <Button type="button" severity="secondary" @click="setPoint('start')"
        >Взять текущее начало</Button
      >
      <label for="cut-end">Конец</label>
      <InputText
        id="cut-end"
        v-model="cut.end.value"
        placeholder="00:00:05.000"
      />
      <Button type="button" severity="secondary" @click="setPoint('end')"
        >Взять текущий конец</Button
      >
      <p v-if="cut.formError.value" class="error">{{ cut.formError.value }}</p>
      <Button type="submit" :loading="cut.create.isPending.value"
        >Создать фрагмент</Button
      >
    </form>
    <p v-if="cut.requestError.value" class="error">
      {{ cut.requestError.value }}
    </p>
    <h4>Задания</h4>
    <p v-if="cut.jobs.isPending.value">Загружаем состояния…</p>
    <p v-else-if="cut.jobs.data.value?.items.length === 0">
      Фрагментов пока нет.
    </p>
    <ol v-else class="jobs">
      <li v-for="job in cut.jobs.data.value?.items" :key="job.id">
        <strong
          >{{ formatTimecode(job.startMs) }}–{{
            formatTimecode(job.endMs)
          }}</strong
        >
        <span>{{ stateLabel(job.state) }} · {{ stageLabel(job.stage) }}</span>
        <span v-if="job.queueReason">{{
          queueReasonLabel(job.queueReason)
        }}</span>
        <span v-if="job.progress">
          {{ job.progress.current }} / {{ job.progress.total }}
          {{ job.progress.unit === "BYTES" ? "байт" : "мс" }}
        </span>
        <span v-if="job.failure" class="error"
          >{{ job.failure.message }} ({{ job.failure.code }})</span
        >
        <a v-if="job.artifact" :href="job.artifact.downloadUrl">Скачать MP4</a>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.manual-cut {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid #c8d2ca;
}
video {
  display: block;
  width: 100%;
  max-height: 28rem;
  background: #111;
}
.cut-form {
  display: grid;
  grid-template-columns: 7rem minmax(10rem, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  margin-top: 1rem;
}
.cut-form p,
.cut-form > button:last-child {
  grid-column: 1 / -1;
}
.jobs {
  display: grid;
  gap: 0.75rem;
  padding-left: 1.25rem;
}
.jobs li {
  display: grid;
  gap: 0.25rem;
  padding: 0.75rem;
  background: #f5f7f5;
  border-radius: 0.5rem;
}
.error {
  color: #a61b1b;
}
@media (max-width: 42rem) {
  .cut-form {
    grid-template-columns: 1fr;
  }
  .cut-form p,
  .cut-form > button:last-child {
    grid-column: auto;
  }
}
</style>
