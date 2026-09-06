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
        <span class="status-tag">{{ label }}</span>
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
        <p>
          MP4 готов к скачиванию: {{ query.data.value.result.filename }} ·
          {{ query.data.value.result.sizeBytes }} байт.
        </p>
        <a class="download" :href="query.data.value.result.downloadUrl"
          >Скачать MP4</a
        >
        <Button
          type="button"
          severity="secondary"
          @click="emit('editEditorial', query.data.value.id)"
          >Заголовок и обложка</Button
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
          >Настроить монтаж</Button
        >
        <AssemblyRenderCard
          v-if="projectId"
          :project-id="projectId"
          :cut-job-id="query.data.value.id"
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
      <Button type="button" severity="secondary" @click="query.refetch()"
        >Обновить сейчас</Button
      >
    </template>
    <p v-else class="error">Не удалось открыть задание.</p>
  </article>
</template>

<style scoped>
.job-card {
  padding: 1rem;
  border: 1px solid #d5ddd7;
  border-radius: 0.75rem;
  background: #fff;
}
.job-heading {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.status-tag {
  padding: 0.25rem 0.6rem;
  border-radius: 99px;
  background: #e7eee9;
  font-weight: 700;
}
progress {
  width: 100%;
  height: 1rem;
}
.download {
  display: inline-block;
  padding: 0.7rem 1rem;
  border-radius: 0.5rem;
  background: #234d35;
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}
.error {
  color: #991b1b;
}
.warning {
  color: #7c4a03;
}
</style>
