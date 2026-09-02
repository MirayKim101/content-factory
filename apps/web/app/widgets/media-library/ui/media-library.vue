<script setup lang="ts">
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { computed, ref, watch } from "vue";
import type { LibraryPage } from "~/shared/api/generated/project";
import type { ProjectListQuery } from "~/shared/api/projects";
import { createProjectsApi } from "~/shared/api/projects";

import { useProjectLibrary } from "~/entities/project/model/use-project-library";
import {
  mergeProjectSelections,
  projectIdsFromReturnTo,
  toggleProjectSelection,
  MAX_SELECTED_PROJECTS,
} from "~/features/select-library-sources/model/selection";
import { formatTimecode } from "~/shared/lib/timecode";

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const returnTo = computed(() =>
  typeof route.query.returnTo === "string" ? route.query.returnTo : undefined,
);
const selected = ref<string[]>(projectIdsFromReturnTo(returnTo.value));
const draftQuery = ref(typeof route.query.q === "string" ? route.query.q : "");
const query = computed<ProjectListQuery>(() => ({
  q: typeof route.query.q === "string" ? route.query.q : undefined,
  status:
    route.query.status === "SOURCE_READY" ||
    route.query.status === "SOURCE_PENDING" ||
    route.query.status === "FAILED_FINAL"
      ? route.query.status
      : undefined,
  cursor:
    typeof route.query.cursor === "string" ? route.query.cursor : undefined,
  limit: 20,
}));
const library = useProjectLibrary(query);
const visibleItems = ref<LibraryPage["items"]>([]);
const statusOptions = [
  { label: "Все статусы", value: undefined },
  { label: "Готово к нарезке", value: "SOURCE_READY" },
  { label: "Проверяется", value: "SOURCE_PENDING" },
  { label: "С ошибкой", value: "FAILED_FINAL" },
];
const selectedCount = computed(() => selected.value.length);
const authorizationTarget = ref<LibraryPage["items"][number] | null>(null);
const attested = ref(false);
const authorizationPending = ref(false);
const authorizationError = ref<string | null>(null);

function updateFilters(next: ProjectListQuery): void {
  void navigateTo({
    path: "/library",
    query: {
      q: next.q,
      status: next.status,
      cursor: next.cursor,
      returnTo: returnTo.value,
    },
  });
}
function search(): void {
  updateFilters({
    q: draftQuery.value.trim() || undefined,
    status: query.value.status,
  });
}
function select(id: string): void {
  selected.value = toggleProjectSelection(selected.value, id);
}
function openAuthorization(item: LibraryPage["items"][number]): void {
  authorizationTarget.value = item;
  attested.value = false;
  authorizationError.value = null;
}
async function confirmAuthorization(): Promise<void> {
  const item = authorizationTarget.value;
  if (!item || !attested.value || authorizationPending.value) return;
  authorizationPending.value = true;
  authorizationError.value = null;
  try {
    await projectsApi.attestSourceAuthorization!({
      projectId: item.id,
      sourceVersion: item.source.sourceVersion,
      expectedRevision: item.source.authorization.revision,
    });
    authorizationTarget.value = null;
    await library.refetch();
  } catch (error) {
    authorizationError.value =
      error instanceof Error ? error.message : "Не удалось сохранить решение.";
  } finally {
    authorizationPending.value = false;
  }
}
function openWorkspace(): void {
  const projectIds = mergeProjectSelections(
    projectIdsFromReturnTo(returnTo.value),
    selected.value,
  );
  if (!projectIds.length) return;
  void navigateTo({
    path: "/horizontal",
    query: { projectIds: projectIds.join(",") },
  });
}
function formatBytes(raw: string): string {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes)) return raw;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}
watch(
  () => route.query.q,
  (value) => (draftQuery.value = typeof value === "string" ? value : ""),
);
watch(
  () => [query.value.q, query.value.status],
  () => {
    visibleItems.value = [];
  },
);
watch(
  () => library.data.value,
  (page) => {
    if (!page) return;
    visibleItems.value = query.value.cursor
      ? [
          ...visibleItems.value,
          ...page.items.filter(
            (item) => !visibleItems.value.some((shown) => shown.id === item.id),
          ),
        ]
      : page.items;
    const selectable = new Set(
      visibleItems.value
        .filter(
          (item) =>
            item.status === "SOURCE_READY" &&
            item.source.authorization.status === "CLEARED",
        )
        .map((item) => item.id),
    );
    selected.value = selected.value.filter(
      (id) =>
        !visibleItems.value.some((item) => item.id === id) ||
        selectable.has(id),
    );
  },
  { immediate: true },
);
</script>

<template>
  <main class="library" aria-labelledby="library-title">
    <header>
      <p class="eyebrow">Content Factory · Этап 1.5</p>
      <h1 id="library-title">Медиатека</h1>
      <p>Все загруженные исходники. Выберите готовые MP4 для ручной нарезки.</p>
      <NuxtLink class="upload-link" to="/">Загрузить видео</NuxtLink>
    </header>
    <form class="filters" @submit.prevent="search">
      <label for="library-search">Поиск по проекту или имени файла</label>
      <InputText id="library-search" v-model="draftQuery" />
      <label for="library-status">Статус</label>
      <Select
        id="library-status"
        :model-value="query.status"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        @update:model-value="
          updateFilters({ q: draftQuery.trim() || undefined, status: $event })
        "
      />
      <Button type="submit">Найти</Button>
    </form>
    <p v-if="selectedCount" class="selection" role="status">
      Выбрано: {{ selectedCount }} из {{ MAX_SELECTED_PROJECTS }}
      <Button type="button" @click="openWorkspace"
        >Открыть в горизонтальных видео</Button
      >
    </p>
    <p v-if="library.isLoading.value && !visibleItems.length" aria-busy="true">
      Загружаем медиатеку…
    </p>
    <template v-else-if="visibleItems.length">
      <section aria-label="Исходные видео">
        <article v-for="item in visibleItems" :key="item.id" class="source-row">
          <div>
            <h2>{{ item.name }}</h2>
            <p>
              {{ item.source.originalFilename }} ·
              {{ formatBytes(item.source.sizeBytes) }} · добавлено
              {{ new Date(item.source.addedAt).toLocaleString("ru-RU") }}
            </p>
            <p
              class="authorization-badge"
              :class="{
                cleared: item.source.authorization.status === 'CLEARED',
              }"
            >
              {{
                item.source.authorization.status === "CLEARED"
                  ? "Права подтверждены"
                  : "Требуется подтверждение прав"
              }}
            </p>
            <p>
              Длительность:
              {{
                item.source.durationMs === undefined
                  ? "проверяется"
                  : formatTimecode(item.source.durationMs)
              }}
              · Нарезки: {{ item.cutJobCounts.total }}, готово:
              {{ item.cutJobCounts.ready }}, ошибок:
              {{ item.cutJobCounts.failed }}
            </p>
          </div>
          <label>
            <input
              type="checkbox"
              :aria-label="`Выбрать ${item.source.originalFilename}`"
              :checked="selected.includes(item.id)"
              :disabled="
                item.status !== 'SOURCE_READY' ||
                item.source.authorization.status !== 'CLEARED' ||
                (!selected.includes(item.id) &&
                  selectedCount >= MAX_SELECTED_PROJECTS)
              "
              @change="select(item.id)"
            />
            Выбрать видео
          </label>
          <Button
            v-if="
              item.status === 'SOURCE_READY' &&
              item.source.authorization.status === 'NOT_REVIEWED'
            "
            type="button"
            severity="secondary"
            @click="openAuthorization(item)"
            >Подтвердить права</Button
          >
          <p v-if="item.status !== 'SOURCE_READY'" class="muted">
            {{
              item.status === "FAILED_FINAL"
                ? "Исходник недоступен после ошибки."
                : "Видео ещё проверяется."
            }}
          </p>
        </article>
        <Button
          v-if="library.data.value?.nextCursor"
          type="button"
          :loading="library.isFetching.value"
          @click="
            updateFilters({
              q: query.q,
              status: query.status,
              cursor: library.data.value?.nextCursor ?? undefined,
            })
          "
          >Загрузить ещё видео</Button
        >
      </section>
      <p
        v-if="library.isError.value && visibleItems.length"
        class="error"
        role="status"
      >
        Не удалось обновить медиатеку. Показан последний полученный список.
        <Button type="button" @click="library.refetch()"
          >Обновить сейчас</Button
        >
      </p>
    </template>
    <div v-else-if="library.isError.value" class="error" role="alert">
      <p>Не удалось обновить медиатеку. Показан последний полученный список.</p>
      <Button type="button" @click="library.refetch()">Обновить сейчас</Button>
    </div>
    <div v-else class="empty">
      <p v-if="query.q">По этому запросу видео не найдено.</p>
      <p v-else>
        Медиатека пока пуста. Загрузите первый MP4, чтобы начать работу.
      </p>
      <Button v-if="query.q" type="button" @click="updateFilters({})"
        >Сбросить поиск</Button
      >
    </div>
    <Dialog
      :visible="authorizationTarget !== null"
      modal
      header="Подтверждение прав на исходник"
      @update:visible="
        authorizationTarget = $event ? authorizationTarget : null
      "
    >
      <p v-if="authorizationTarget">
        Подтверждение относится только к версии
        {{ authorizationTarget.source.sourceVersion }} файла «{{
          authorizationTarget.source.originalFilename
        }}».
      </p>
      <label class="attestation-row">
        <Checkbox v-model="attested" binary />
        <span
          >Подтверждаю, что имею право использовать и обрабатывать это
          видео.</span
        >
      </label>
      <p v-if="authorizationError" class="error" role="alert">
        {{ authorizationError }}
      </p>
      <template #footer>
        <Button
          type="button"
          severity="secondary"
          @click="authorizationTarget = null"
          >Отмена</Button
        >
        <Button
          type="button"
          :disabled="!attested || authorizationPending"
          @click="confirmAuthorization"
          >{{ authorizationPending ? "Сохраняем…" : "Подтвердить" }}</Button
        >
      </template>
    </Dialog>
  </main>
</template>

<style scoped>
.library {
  box-sizing: border-box;
  max-width: 76rem;
  margin: 0 auto;
  padding: 2rem clamp(1rem, 3vw, 3rem) 5rem;
}
.eyebrow {
  color: #65736b;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.filters {
  display: grid;
  grid-template-columns: 1fr 12rem auto;
  gap: 0.65rem;
  align-items: end;
  padding: 1rem;
  background: #fff;
  border: 1px solid #d9e0d8;
  border-radius: 0.75rem;
}
.filters label {
  font-weight: 650;
}
.selection {
  display: flex;
  gap: 1rem;
  align-items: center;
  padding: 1rem;
  background: #e8f2ea;
}
.source-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  padding: 1rem;
  border-bottom: 1px solid #d9e0d8;
  background: #fff;
}
.source-row h2 {
  margin: 0;
  font-size: 1.1rem;
}
.source-row p {
  margin: 0.35rem 0;
  color: #526159;
}
.muted {
  grid-column: 1/-1;
}
.authorization-badge {
  display: inline-block;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: #fff7d6;
  color: #765800;
  font-weight: 700;
}
.authorization-badge.cleared {
  background: #e8f2ea;
  color: #234d35;
}
.attestation-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.upload-link {
  display: inline-block;
  margin: 1rem 0;
}
.error {
  padding: 1rem;
  background: #fff1f1;
  color: #991b1b;
}
.empty {
  padding: 2rem;
  background: #fff;
  border: 1px solid #d9e0d8;
}
@media (max-width: 700px) {
  .filters {
    grid-template-columns: 1fr;
  }
  .source-row {
    grid-template-columns: 1fr;
  }
  .source-row label {
    min-height: 44px;
  }
}
</style>
