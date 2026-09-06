<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import Button from "primevue/button";
import { computed } from "vue";

import {
  createEditorialExportsApi,
  type EditorialExport,
} from "~/shared/api/editorial-exports";

const props = defineProps<{ projectId: string; cutJobId: string }>();
const config = useRuntimeConfig();
const api = createEditorialExportsApi(config.public.apiBasePath);
const query = useQuery({
  queryKey: computed(() => ["editorial-exports", props.projectId]),
  queryFn: () => api.list(props.projectId),
  retry: 2,
  refetchInterval: (state) => {
    const active = ((state.state.data ?? []) as EditorialExport[]).some(
      (item) =>
        item.cutPipelineJobId === props.cutJobId &&
        ["QUEUED", "PROCESSING", "RETRY_WAIT"].includes(item.job.state),
    );
    return active ? (document.hidden ? 15_000 : 2_000) : false;
  },
});
const exportsForCut = computed(() =>
  query.isError.value
    ? []
    : (query.data.value ?? []).filter(
        (item) => item.cutPipelineJobId === props.cutJobId,
      ),
);
function stateLabel(value: EditorialExport): string {
  return {
    QUEUED: "В очереди экспорта",
    PROCESSING: "Создаётся ZIP",
    RETRY_WAIT: "Ожидает автоматического повтора",
    READY: "Пакет готов",
    FAILED_FINAL: "Экспорт не выполнен",
  }[value.job.state];
}
function phase(value: EditorialExport): string | undefined {
  const phase = value.job.progress?.phase;
  return phase
    ? {
        READ_INPUTS: "Читаем видео и обложку",
        WRITE_ARCHIVE: "Собираем ZIP",
        OUTPUT_HASH: "Проверяем целостность пакета",
        UPLOAD: "Сохраняем пакет",
        FINALIZE: "Завершаем экспорт",
      }[phase]
    : undefined;
}
function percent(value: EditorialExport): number | undefined {
  return value.job.progress
    ? Math.round(value.job.progress.basisPoints / 100)
    : undefined;
}
</script>

<template>
  <section
    v-if="exportsForCut.length || query.isError.value"
    class="export-list"
    aria-label="Экспорт редакционного пакета"
  >
    <p v-if="query.isError.value" class="warning" role="status">
      Не удалось обновить экспорт. Показаны последние подтверждённые данные.
      <Button
        label="Обновить"
        severity="secondary"
        size="small"
        @click="query.refetch()"
      />
    </p>
    <article
      v-for="item in exportsForCut"
      :key="item.id"
      class="export-card"
      :aria-busy="item.job.state === 'PROCESSING'"
    >
      <div class="export-heading">
        <strong>Пакет для публикации</strong>
        <span class="status-tag">{{ stateLabel(item) }}</span>
      </div>
      <p v-if="!item.approvalCurrent" class="warning">
        Версия подтверждения больше не актуальна. Скачивание заблокировано
        сервером.
      </p>
      <p v-if="item.job.state === 'QUEUED'">
        Ожидает свободный слот обработки.
      </p>
      <p v-else-if="item.job.state === 'RETRY_WAIT'">
        Попытка {{ item.job.attempt }} из
        {{ item.job.retryBudget + 1 }} завершилась неудачно; система повторит её
        автоматически.
      </p>
      <template v-else-if="item.job.state === 'PROCESSING'">
        <p>
          {{ phase(item) ?? "Подготавливаем экспорт"
          }}<template v-if="percent(item) !== undefined">
            · {{ percent(item) }}%</template
          >.
        </p>
        <progress
          v-if="percent(item) !== undefined"
          :value="percent(item)"
          max="100"
          :aria-label="`Прогресс экспорта ${percent(item)}%`"
        />
        <progress v-else aria-label="Экспорт без измеримого прогресса" />
      </template>
      <template
        v-else-if="
          item.job.state === 'READY' && item.result && item.approvalCurrent
        "
      >
        <p>
          ZIP готов: {{ item.result.filename }} ·
          {{ item.result.sizeBytes }} байт.
        </p>
        <a class="download" :href="item.result.downloadUrl"
          >Скачать ZIP-пакет</a
        >
      </template>
      <div v-else-if="item.job.failure" class="error" role="alert">
        <p>{{ item.job.failure.message }}</p>
        <details>
          <summary>Код ошибки</summary>
          <code>{{ item.job.failure.code }}</code>
        </details>
      </div>
    </article>
  </section>
</template>

<style scoped>
.export-list {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.export-card {
  display: grid;
  gap: 0.55rem;
  padding: 0.8rem;
  border: 1px solid #cfdad2;
  border-radius: 0.65rem;
  background: #f8fbf8;
}
.export-card p {
  margin: 0;
}
.export-heading {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.status-tag {
  padding: 0.2rem 0.5rem;
  border-radius: 99px;
  background: #e3eee5;
  font-weight: 700;
  font-size: 0.85rem;
}
progress {
  width: 100%;
  height: 0.85rem;
}
.download {
  display: inline-flex;
  width: fit-content;
  padding: 0.6rem 0.8rem;
  border-radius: 0.45rem;
  background: #234d35;
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}
.warning {
  color: #7c4a03;
}
.error {
  color: #991b1b;
}
</style>
