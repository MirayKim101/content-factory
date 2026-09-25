<script setup lang="ts">
import Button from "primevue/button";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";

import {
  createAssemblyRendersApi,
  type AssemblyRender,
} from "~/shared/api/assembly-renders";

const props = defineProps<{ projectId: string; cutJobId: string }>();
const emit = defineEmits<{
  review: [payload: { jobId: string; renderId: string }];
}>();
const config = useRuntimeConfig();
const api = createAssemblyRendersApi(config.public.apiBasePath);
const query = useQuery({
  queryKey: computed(() => ["assembly-renders", props.projectId]),
  queryFn: () => api.list(props.projectId),
  retry: 2,
  refetchInterval: (state) => {
    const items = (state.state.data ?? []) as AssemblyRender[];
    const active = items.some(
      (item) =>
        item.cutPipelineJobId === props.cutJobId &&
        (item.job.state === "QUEUED" ||
          item.job.state === "PROCESSING" ||
          item.job.state === "RETRY_WAIT"),
    );
    if (!active) return false;
    return document.hidden ? 15_000 : 2_000;
  },
});
const renders = computed(() =>
  (query.data.value ?? []).filter(
    (item) => item.cutPipelineJobId === props.cutJobId,
  ),
);
function title(render: AssemblyRender): string {
  return `Сборка revision ${render.recipeRevision}`;
}
function status(render: AssemblyRender): string {
  return {
    QUEUED: "В очереди сборки",
    PROCESSING: "Собирается",
    RETRY_WAIT: "Ожидает повторной попытки",
    READY: "Готово",
    FAILED_FINAL: "Сборка не выполнена",
  }[render.job.state];
}
function phase(render: AssemblyRender): string | undefined {
  const value = render.job.progress?.phase;
  return value
    ? {
        DOWNLOAD: "Подготавливаем материалы",
        AUDIO_ANALYSIS: "Анализируем звук",
        ENCODE: "Кодируем видео",
        OUTPUT_PROBE: "Проверяем готовый файл",
        OUTPUT_HASH: "Проверяем целостность",
        UPLOAD: "Сохраняем результат",
        FINALIZE: "Завершаем сборку",
      }[value]
    : undefined;
}
function percent(render: AssemblyRender): number | undefined {
  return render.job.progress
    ? Math.round(render.job.progress.basisPoints / 100)
    : undefined;
}
</script>

<template>
  <section
    v-if="renders.length || query.isError.value"
    class="render-list"
    aria-label="Сборка готового видео"
  >
    <p v-if="query.isError.value" class="warning" role="status">
      Не удалось обновить статус сборки. Показаны последние подтверждённые
      данные.
      <Button
        label="Обновить"
        severity="secondary"
        size="small"
        @click="query.refetch()"
      />
    </p>
    <article
      v-for="render in renders"
      :key="render.id"
      class="render-card"
      :aria-busy="render.job.state === 'PROCESSING'"
    >
      <div class="render-heading">
        <strong>{{ title(render) }}</strong>
        <span class="status-tag">{{ status(render) }}</span>
      </div>
      <p v-if="render.job.state === 'QUEUED'">Ожидает свободный слот сборки.</p>
      <p v-else-if="render.job.state === 'RETRY_WAIT'">
        Попытка {{ render.job.attempt }} из {{ render.job.retryBudget + 1 }} не
        удалась; система повторит её автоматически.
      </p>
      <template v-else-if="render.job.state === 'PROCESSING'">
        <p>
          {{ phase(render) ?? "Подготавливаем сборку"
          }}<template v-if="percent(render) !== undefined">
            · {{ percent(render) }}%</template
          >.
        </p>
        <progress
          v-if="percent(render) !== undefined"
          :value="percent(render)"
          max="100"
          :aria-label="`Прогресс сборки ${percent(render)}%`"
        />
        <progress v-else aria-label="Сборка без измеримого прогресса" />
      </template>
      <template v-else-if="render.job.state === 'READY' && render.result">
        <div class="render-result">
          <div>
            <span>Финальная сборка готова</span>
            <p>{{ render.result.filename }}</p>
          </div>
          <span class="ready-check" aria-hidden="true">✓</span>
        </div>
        <div class="render-actions">
          <Button
            label="Проверить и подтвердить"
            @click="
              emit('review', { jobId: props.cutJobId, renderId: render.id })
            "
          />
          <a class="secondary-download" :href="render.result.downloadUrl"
            >Скачать видео</a
          >
        </div>
      </template>
      <div v-else-if="render.job.failure" class="error" role="alert">
        <p>{{ render.job.failure.message }}</p>
        <details>
          <summary>Код ошибки</summary>
          <code>{{ render.job.failure.code }}</code>
        </details>
      </div>
    </article>
  </section>
</template>

<style scoped>
.render-list {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.render-card {
  display: grid;
  gap: 0.55rem;
  padding: 0.8rem;
  border: 1px solid var(--cf-border);
  border-radius: 0.65rem;
  background: #fff;
}
.render-card p {
  margin: 0;
}
.render-heading {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.status-tag {
  padding: 0.2rem 0.5rem;
  border-radius: 99px;
  background: var(--cf-success-soft);
  color: var(--cf-success);
  font-weight: 700;
  font-size: 0.85rem;
}
progress {
  width: 100%;
  height: 0.85rem;
}
.render-result {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.75rem;
  border-radius: var(--cf-radius-sm);
  background: var(--cf-success-soft);
}
.render-result span:first-child {
  color: var(--cf-success);
  font-size: 0.72rem;
  font-weight: 750;
}
.render-result p {
  font-weight: 680;
}
.ready-check {
  display: grid;
  flex: 0 0 1.8rem;
  width: 1.8rem;
  height: 1.8rem;
  place-items: center;
  border-radius: 50%;
  background: var(--cf-success);
  color: #fff;
  font-weight: 800;
}
.render-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.secondary-download {
  display: inline-flex;
  width: fit-content;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--cf-border-strong);
  border-radius: var(--cf-radius-sm);
  background: #fff;
  color: var(--cf-text);
  font-weight: 700;
  text-decoration: none;
}
.secondary-download:hover {
  background: var(--cf-surface-muted);
}
.warning {
  color: var(--cf-warning);
}
.error {
  color: var(--cf-danger);
}
</style>
