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
import { formatDisplayTimecode } from "~/shared/lib/timecode";

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
            item.status === "SOURCE_READY" && item.source.authorization.usable,
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
    <header class="library-header">
      <div>
        <nav class="breadcrumbs" aria-label="Хлебные крошки">
          <span>Производство</span><span aria-hidden="true">/</span
          ><strong>Медиатека</strong>
        </nav>
        <p class="eyebrow">Управление источниками</p>
        <h1 id="library-title">Медиатека</h1>
        <p>Найдите разрешённый исходник и добавьте его в рабочую очередь.</p>
      </div>
      <NuxtLink class="upload-link" to="/">+ Загрузить видео</NuxtLink>
    </header>
    <form class="filters" @submit.prevent="search">
      <label class="filter-field" for="library-search">
        <span>Поиск</span>
        <InputText
          id="library-search"
          v-model="draftQuery"
          placeholder="Проект или имя файла"
        />
      </label>
      <label class="filter-field" for="library-status">
        <span>Статус</span>
        <Select
          input-id="library-status"
          :model-value="query.status"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          @update:model-value="
            updateFilters({ q: draftQuery.trim() || undefined, status: $event })
          "
        />
      </label>
      <Button type="submit">Найти</Button>
    </form>
    <p v-if="selectedCount" class="selection" role="status">
      <span><strong>{{ selectedCount }}</strong> из {{ MAX_SELECTED_PROJECTS }} выбрано</span>
      <Button type="button" @click="openWorkspace"
        >Открыть в горизонтальных видео</Button
      >
    </p>
    <p v-if="library.isLoading.value && !visibleItems.length" aria-busy="true">
      Загружаем медиатеку…
    </p>
    <template v-else-if="visibleItems.length">
      <section class="source-list" aria-label="Исходные видео">
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
                cleared: item.source.authorization.usable,
              }"
            >
              {{
                item.source.authorization.usable
                  ? "Права подтверждены"
                  : "Требуется подтверждение прав"
              }}
            </p>
            <p>
              Длительность:
              {{
                item.source.durationMs === undefined
                  ? "проверяется"
                  : formatDisplayTimecode(item.source.durationMs)
              }}
              · Нарезки: {{ item.cutJobCounts.total }}, готово:
              {{ item.cutJobCounts.ready }}, ошибок:
              {{ item.cutJobCounts.failed }}
            </p>
          </div>
          <label :for="`select-source-${item.id}`">
            <Checkbox
              :input-id="`select-source-${item.id}`"
              binary
              :aria-label="`Выбрать ${item.source.originalFilename}`"
              :model-value="selected.includes(item.id)"
              :disabled="
                item.status !== 'SOURCE_READY' ||
                !item.source.authorization.usable ||
                (!selected.includes(item.id) &&
                  selectedCount >= MAX_SELECTED_PROJECTS)
              "
              @update:model-value="select(item.id)"
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
          <p
            v-else-if="
              item.status === 'SOURCE_READY' &&
              item.source.authorization.status === 'CLEARED' &&
              !item.source.authorization.usable
            "
            class="warning"
          >
            Локальное разрешение недействительно в этом режиме. Перед ручным
            подтверждением администратор должен сбросить решение.
          </p>
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
  max-width: 90rem;
  margin: 0 auto;
  padding: 2.25rem clamp(1rem, 3vw, 3rem) 5rem;
}
.library-header {
  display: flex;
  gap: 1.5rem;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
.library-header h1 {
  margin: 0.15rem 0 0.35rem;
  font-size: clamp(1.8rem, 3vw, 2.4rem);
  letter-spacing: -0.035em;
}
.library-header p:last-child {
  margin: 0;
  color: var(--cf-text-muted);
}
.breadcrumbs {
  display: flex;
  gap: 0.45rem;
  margin-bottom: 1rem;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
}
.eyebrow {
  margin: 0;
  color: var(--cf-brand);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.filters {
  display: grid;
  grid-template-columns: 1fr 12rem auto;
  gap: 0.65rem;
  align-items: end;
  padding: 1rem;
  background: #fff;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  box-shadow: var(--cf-shadow-sm);
}
.filter-field {
  display: grid;
  gap: 0.35rem;
}
.filter-field > span {
  color: var(--cf-text-muted);
  font-size: 0.72rem;
  font-weight: 650;
}
.selection {
  position: sticky;
  top: 0.75rem;
  z-index: 4;
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border: 1px solid #a8cdbd;
  border-radius: var(--cf-radius-md);
  background: rgb(229 244 238 / 0.96);
  box-shadow: var(--cf-shadow-sm);
  backdrop-filter: blur(12px);
}
.source-list {
  margin-top: 1rem;
  overflow: hidden;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  background: #fff;
  box-shadow: var(--cf-shadow-sm);
}
.source-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid var(--cf-border);
  background: #fff;
}
.source-row:last-of-type {
  border-bottom: 0;
}
.source-row h2 {
  margin: 0;
  font-size: 1.1rem;
}
.source-row p {
  margin: 0.35rem 0;
  color: var(--cf-text-muted);
  font-size: 0.83rem;
}
.muted {
  grid-column: 1/-1;
}
.authorization-badge {
  display: inline-block;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: var(--cf-warning-soft);
  color: var(--cf-warning);
  font-weight: 700;
}
.authorization-badge.cleared {
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
.attestation-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.upload-link {
  display: inline-flex;
  flex: 0 0 auto;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.9rem;
  border-radius: var(--cf-radius-sm);
  background: var(--cf-brand);
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}
.error {
  padding: 1rem;
  border-radius: var(--cf-radius-md);
  background: var(--cf-danger-soft);
  color: var(--cf-danger);
}
.empty {
  padding: 2rem;
  background: #fff;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
}
@media (max-width: 700px) {
  .library {
    padding: 1.25rem 0.85rem 4rem;
  }
  .library-header,
  .selection {
    align-items: stretch;
    flex-direction: column;
  }
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
