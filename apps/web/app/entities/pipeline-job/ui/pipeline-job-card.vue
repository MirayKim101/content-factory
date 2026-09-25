<script setup lang="ts">
import Button from "primevue/button";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";

import {
  createMediaPipelineApi,
  type PipelineJob,
} from "~/shared/api/media-pipeline";
import { formatDisplayTimecode } from "~/shared/lib/timecode";
import AssemblyRenderCard from "~/entities/assembly-render/ui/assembly-render-card.vue";

const props = defineProps<{ jobId: string; projectId?: string }>();
const emit = defineEmits<{
  cloneSegment: [bounds: { startMs: number; endMs: number }];
  editEditorial: [jobId: string];
  editAssembly: [payload: { jobId: string; durationMs: number }];
  reviewEditorial: [payload: { jobId: string; renderId: string }];
  editCreatorContext: [jobId: string];
  viewFrames: [jobId: string];
}>();
const config = useRuntimeConfig();
const api = createMediaPipelineApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const query = useQuery({
  queryKey: computed(() => ["pipeline-job", props.jobId]),
  queryFn: async () => {
    const next = await api.getJob(props.jobId);
    const current = queryClient.getQueryData<PipelineJob>([
      "pipeline-job",
      props.jobId,
    ]);
    return current && current.revision > next.revision ? current : next;
  },
  refetchInterval: (state) => {
    const job = state.state.data;
    if (job?.state === "READY" || job?.state === "FAILED_FINAL") return false;
    if (document.hidden) return 15_000;
    return job?.state === "PROCESSING" ? 2_000 : 5_000;
  },
  retry: 3,
});
const percent = computed(() => {
  const job = query.data.value;
  return job?.processedMs !== undefined && job.totalMs
    ? Math.min(100, Math.round((job.processedMs / job.totalMs) * 100))
    : null;
});
const label = computed(
  () =>
    ({
      QUEUED: "В очереди",
      RETRY_WAIT: "Ожидает повторной попытки",
      PROCESSING: "Обрабатывается",
      READY: "Готово",
      FAILED_FINAL: "Не обработано",
    })[query.data.value?.state ?? "QUEUED"],
);
function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value} байт`;
  if (bytes >= 1_073_741_824)
    return `${(bytes / 1_073_741_824).toFixed(2)} ГиБ`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} МиБ`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} КиБ`;
  return `${bytes} байт`;
}
</script>

<template>
  <article class="job-card" :aria-busy="query.isLoading.value">
    <p v-if="query.isLoading.value">Загружаем статус задания…</p>
    <template v-else-if="query.data.value">
      <div class="job-heading">
        <strong
          >{{ formatDisplayTimecode(query.data.value.startMs) }}–{{
            formatDisplayTimecode(query.data.value.endMs)
          }}</strong
        >
        <span class="status-tag" :data-state="query.data.value.state">{{ label }}</span>
      </div>
      <p v-if="query.data.value.state === 'QUEUED'">
        Ожидает свободный слот обработки.
      </p>
      <p v-else-if="query.data.value.state === 'RETRY_WAIT'">
        Первая попытка завершилась неудачно. Задание сохранено и будет
        повторено.
      </p>
      <div v-else-if="query.data.value.state === 'PROCESSING'">
        <p v-if="percent !== null">
          Обработано
          {{ formatDisplayTimecode(query.data.value.processedMs ?? 0) }} из
          {{ formatDisplayTimecode(query.data.value.totalMs ?? 0) }} ({{
            percent
          }}%).
        </p>
        <p v-else>Обработка началась. Точный прогресс пока недоступен.</p>
        <progress
          v-if="percent !== null"
          max="100"
          :value="percent"
          aria-label="Прогресс нарезки"
        />
        <progress v-else aria-label="Обработка без измеримого прогресса" />
      </div>
      <div
        v-else-if="
          query.data.value.state === 'READY' && query.data.value.result
        "
      >
        <div class="ready-summary">
          <div>
            <span class="ready-kicker">Результат нарезки</span>
            <strong>{{ query.data.value.result.filename }}</strong>
            <small>{{ formatBytes(query.data.value.result.sizeBytes) }}</small>
          </div>
          <a class="download" :href="query.data.value.result.downloadUrl"
            >Скачать MP4</a
          >
        </div>
        <div class="workflow-actions" aria-label="Основные шаги подготовки">
          <Button
            type="button"
            severity="secondary"
            @click="emit('editEditorial', query.data.value.id)"
            >1. Заголовок и обложка</Button
          >
          <Button
            type="button"
            severity="secondary"
            @click="
              emit('editAssembly', {
                jobId: query.data.value.id,
                durationMs: query.data.value.endMs - query.data.value.startMs,
              })
            "
            >2. Настроить монтаж</Button
          >
        </div>
        <details class="support-tools">
          <summary>Дополнительные инструменты</summary>
          <div>
            <Button
              v-if="config.public.aiContextEnabled === true"
              type="button"
              severity="secondary"
              @click="emit('editCreatorContext', query.data.value.id)"
              >Контекст автора и prompt</Button
            >
            <Button
              v-if="projectId"
              type="button"
              severity="secondary"
              @click="emit('viewFrames', query.data.value.id)"
              >Кадры нарезки</Button
            >
          </div>
        </details>
        <AssemblyRenderCard
          v-if="projectId"
          :project-id="projectId"
          :cut-job-id="query.data.value.id"
          @review="emit('reviewEditorial', $event)"
        />
      </div>
      <div v-else-if="query.data.value.failure" class="error" role="alert">
        <p>{{ query.data.value.failure.message }}</p>
        <details>
          <summary>Код ошибки</summary>
          <code>{{ query.data.value.failure.code }}</code>
        </details>
        <Button
          type="button"
          severity="secondary"
          @click="
            emit('cloneSegment', {
              startMs: query.data.value!.startMs,
              endMs: query.data.value!.endMs,
            })
          "
          >Создать новый отрезок с этими границами</Button
        >
      </div>
      <p v-if="query.isError.value" class="warning" role="status">
        Не удалось обновить статус. Показаны последние подтверждённые данные.
      </p>
      <Button
        class="refresh-button"
        type="button"
        severity="secondary"
        text
        size="small"
        @click="query.refetch()"
        >Обновить сейчас</Button
      >
    </template>
    <p v-else class="error">Не удалось открыть задание.</p>
  </article>
</template>

<style scoped>
.job-card {
  display: grid;
  gap: 0.8rem;
  padding: 0.9rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: var(--cf-surface-subtle);
}
.job-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.status-tag {
  padding: 0.25rem 0.6rem;
  border-radius: 99px;
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
  font-weight: 700;
  font-size: 0.75rem;
}
.status-tag[data-state="READY"] {
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
.status-tag[data-state="PROCESSING"],
.status-tag[data-state="QUEUED"],
.status-tag[data-state="RETRY_WAIT"] {
  background: var(--cf-info-soft);
  color: var(--cf-info);
}
.status-tag[data-state="FAILED_FINAL"] {
  background: var(--cf-danger-soft);
  color: var(--cf-danger);
}
progress {
  width: 100%;
  height: 1rem;
}
.download {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 0.55rem 0.75rem;
  border-radius: 0.5rem;
  background: #234d35;
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}
.ready-summary {
  display: flex;
  gap: 0.8rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-sm);
  background: #fff;
}
.ready-summary > div {
  display: grid;
  min-width: 0;
}
.ready-summary strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ready-summary small,
.ready-kicker {
  color: var(--cf-text-muted);
  font-size: 0.72rem;
}
.workflow-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 0.65rem;
}
.workflow-actions :deep(.p-button) {
  justify-content: flex-start;
}
.support-tools {
  margin-top: 0.6rem;
  border-top: 1px solid var(--cf-border);
}
.support-tools summary {
  padding: 0.65rem 0 0;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
  font-weight: 650;
  cursor: pointer;
}
.support-tools > div {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding-top: 0.6rem;
}
.refresh-button {
  width: fit-content;
  min-height: 2rem !important;
  padding: 0.3rem 0.45rem !important;
  color: var(--cf-text-muted) !important;
  font-size: 0.74rem !important;
}
.error {
  color: var(--cf-danger);
}
.warning {
  color: var(--cf-warning);
}
@media (max-width: 36rem) {
  .ready-summary {
    align-items: stretch;
    flex-direction: column;
  }
  .ready-summary .download,
  .workflow-actions {
    width: 100%;
  }
  .workflow-actions {
    grid-template-columns: 1fr;
  }
}
</style>
