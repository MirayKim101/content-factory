<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { computed, onMounted, ref, watch } from "vue";

import {
  createEditorialExportsApi,
  type EditorialExport,
} from "~/shared/api/editorial-exports";
import { createProjectsApi } from "~/shared/api/projects";
import {
  createPublicationsApi,
  type PublicationChannel,
  type PublicationIntent,
} from "~/shared/api/publications";
import {
  createVerticalRendersApi,
  type VerticalRender,
} from "~/shared/api/vertical-renders";

type ProjectOption = { id: string; name: string };

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const exportsApi = createEditorialExportsApi(config.public.apiBasePath);
const publicationsApi = createPublicationsApi(config.public.apiBasePath);
const verticalApi = createVerticalRendersApi(config.public.apiBasePath);
const projects = ref<ProjectOption[]>([]);
const projectId = ref("");
const channels = ref<PublicationChannel[]>([]);
const publications = ref<PublicationIntent[]>([]);
const exports = ref<EditorialExport[]>([]);
const verticals = ref<VerticalRender[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const initialized = ref(false);
const exportId = ref("");
const contentKind = ref<"EDITORIAL_EXPORT" | "VERTICAL_RESULT">(
  "EDITORIAL_EXPORT",
);
const verticalId = ref("");
const title = ref("");
const description = ref("");
const scheduledLocal = ref(defaultSchedule());
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const readyExports = computed(() =>
  exports.value.filter(
    (item) => item.job.state === "READY" && item.approvalCurrent && item.result,
  ),
);
const readyVerticals = computed(() =>
  verticals.value.filter(
    (item) => item.job.state === "READY" && item.result?.approval,
  ),
);
const activeChannel = computed(() =>
  channels.value.find(
    (item) => item.platform === "LOCAL_DRY_RUN" && item.state === "ENABLED",
  ),
);
const grouped = computed(() => ({
  planned: publications.value.filter((item) =>
    ["SCHEDULED", "QUEUED"].includes(item.state),
  ),
  processing: publications.value.filter((item) =>
    ["PROCESSING"].includes(item.state),
  ),
  complete: publications.value.filter((item) =>
    ["DRY_RUN_READY", "PUBLISHED"].includes(item.state),
  ),
  attention: publications.value.filter((item) =>
    ["UNKNOWN_REMOTE_STATE", "FAILED_FINAL", "CANCELED"].includes(item.state),
  ),
}));

async function loadProjects(): Promise<void> {
  const page = await projectsApi.listProjects!({ limit: 100 });
  projects.value = page.items.map(({ id, name }) => ({ id, name }));
  const requested =
    typeof route.query.projectId === "string" ? route.query.projectId : "";
  projectId.value = projects.value.some((item) => item.id === requested)
    ? requested
    : (projects.value[0]?.id ?? "");
}
async function loadWorkspace(): Promise<void> {
  if (!projectId.value) {
    channels.value = [];
    publications.value = [];
    exports.value = [];
    verticals.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const [nextChannels, nextPublications, nextExports, nextVerticals] =
      await Promise.all([
        publicationsApi.listChannels(projectId.value),
        publicationsApi.list(projectId.value),
        exportsApi.list(projectId.value),
        verticalApi.list(projectId.value),
      ]);
    channels.value = nextChannels;
    publications.value = nextPublications.items;
    exports.value = nextExports;
    verticals.value = nextVerticals;
    if (!readyExports.value.some((item) => item.id === exportId.value))
      exportId.value = readyExports.value[0]?.id ?? "";
    if (!readyVerticals.value.some((item) => item.id === verticalId.value))
      verticalId.value = readyVerticals.value[0]?.id ?? "";
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось загрузить очередь.";
  } finally {
    loading.value = false;
  }
}
async function createChannel(): Promise<void> {
  if (!projectId.value || saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await publicationsApi.createDryRunChannel(projectId.value, {
      displayName: "Локальная проверка",
      timezone,
    });
    notice.value = "Канал безопасной проверки подключён.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось подключить канал.";
  } finally {
    saving.value = false;
  }
}
async function schedule(): Promise<void> {
  const selectedExport = readyExports.value.find(
    (item) => item.id === exportId.value,
  );
  const selectedVertical = readyVerticals.value.find(
    (item) => item.id === verticalId.value,
  );
  if (
    !projectId.value ||
    !activeChannel.value ||
    (contentKind.value === "EDITORIAL_EXPORT"
      ? !selectedExport?.result
      : !selectedVertical?.result?.approval) ||
    saving.value
  )
    return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    const lineage =
      contentKind.value === "EDITORIAL_EXPORT"
        ? {
            contentKind: "EDITORIAL_EXPORT" as const,
            approvalId: selectedExport!.approvalId,
            exportResultId: selectedExport!.result!.id,
          }
        : {
            contentKind: "VERTICAL_RESULT" as const,
            verticalApprovalId: selectedVertical!.result!.approval!.id,
            verticalResultId: selectedVertical!.result!.id,
          };
    await publicationsApi.create(
      projectId.value,
      {
        channelId: activeChannel.value.id,
        ...lineage,
        scheduledAt: new Date(scheduledLocal.value).toISOString(),
        timezone,
        metadataSnapshot: {
          title: title.value.trim() || projectName(projectId.value),
          description: description.value.trim(),
          source: "content-factory-ui-v1",
        },
      },
      `publication-ui-${crypto.randomUUID()}`,
    );
    notice.value = "Публикация добавлена в очередь.";
    title.value = "";
    description.value = "";
    scheduledLocal.value = defaultSchedule();
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось создать публикацию.";
  } finally {
    saving.value = false;
  }
}
async function cancel(item: PublicationIntent): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await publicationsApi.cancel(item.id);
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось отменить публикацию.";
  } finally {
    saving.value = false;
  }
}
function projectName(id: string): string {
  return projects.value.find((item) => item.id === id)?.name ?? "Публикация";
}
function metadataTitle(item: PublicationIntent): string {
  const value = item.metadataSnapshot.title;
  return typeof value === "string" && value.trim()
    ? value
    : projectName(item.projectId);
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function stateLabel(state: PublicationIntent["state"]): string {
  return (
    {
      SCHEDULED: "Запланировано",
      QUEUED: "В очереди",
      PROCESSING: "Публикуется",
      UNKNOWN_REMOTE_STATE: "Нужна сверка",
      DRY_RUN_READY: "Проверено",
      PUBLISHED: "Опубликовано",
      FAILED_FINAL: "Ошибка",
      CANCELED: "Отменено",
    } as const
  )[state];
}
function defaultSchedule(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

watch(projectId, () => {
  if (initialized.value) void loadWorkspace();
});
onMounted(async () => {
  try {
    await loadProjects();
    initialized.value = true;
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось загрузить проекты.";
    loading.value = false;
  }
});
</script>

<template>
  <main class="publication-page" aria-labelledby="publication-title">
    <header class="page-header">
      <div>
        <nav class="breadcrumbs" aria-label="Хлебные крошки">
          <span>Производство</span><span aria-hidden="true">/</span
          ><strong>Публикации</strong>
        </nav>
        <p class="eyebrow">Контент · Дистрибуция</p>
        <h1 id="publication-title">Календарь публикаций</h1>
        <p class="intro">
          Планируйте выход готового контента и контролируйте каждый этап из
          одной очереди.
        </p>
      </div>
      <label class="project-switcher">
        <span>Проект</span>
        <Select
          v-model="projectId"
          :options="projects"
          option-label="name"
          option-value="id"
          placeholder="Выберите проект"
        />
      </label>
    </header>

    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message success" role="status">{{ notice }}</p>

    <section class="summary" aria-label="Сводка публикаций">
      <article>
        <span>Запланировано</span><strong>{{ grouped.planned.length }}</strong
        ><small>ожидают своего времени</small>
      </article>
      <article>
        <span>В работе</span><strong>{{ grouped.processing.length }}</strong
        ><small>активные операции</small>
      </article>
      <article>
        <span>Готово</span><strong>{{ grouped.complete.length }}</strong
        ><small>проверено или опубликовано</small>
      </article>
      <article>
        <span>Требует внимания</span
        ><strong>{{ grouped.attention.length }}</strong
        ><small>сверка, ошибки и отмены</small>
      </article>
    </section>

    <div class="workspace-grid">
      <section class="queue-panel" aria-labelledby="queue-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Операционная очередь</p>
            <h2 id="queue-title">Ближайшие публикации</h2>
          </div>
          <Button
            severity="secondary"
            :disabled="loading"
            @click="loadWorkspace"
            >Обновить</Button
          >
        </div>
        <p v-if="loading" class="empty" aria-busy="true">
          Обновляем расписание…
        </p>
        <div v-else-if="publications.length" class="publication-list">
          <article
            v-for="item in publications"
            :key="item.id"
            class="publication-card"
          >
            <time :datetime="item.scheduledAt"
              ><strong>{{ formatDate(item.scheduledAt) }}</strong
              ><small>{{ item.timezone }}</small></time
            >
            <div class="publication-main">
              <div class="title-row">
                <h3>{{ metadataTitle(item) }}</h3>
                <span class="status" :data-state="item.state">{{
                  stateLabel(item.state)
                }}</span>
              </div>
              <p>
                {{
                  item.contentKind === "VERTICAL_RESULT"
                    ? "Вертикальный ролик · "
                    : "Горизонтальный пакет · "
                }}
                {{
                  item.platform === "LOCAL_DRY_RUN"
                    ? "Безопасная локальная проверка без внешней отправки"
                    : item.platform
                }}
              </p>
              <small v-if="item.failure">{{ item.failure.message }}</small>
              <small
                v-if="item.state === 'UNKNOWN_REMOTE_STATE'"
                class="reconciliation-note"
              >
                Повторная отправка заблокирована до сверки с площадкой<span
                  v-if="item.remotePublicationId"
                  >. Remote ID: {{ item.remotePublicationId }}</span
                ><span v-if="item.remoteStatus">
                  · Статус: {{ item.remoteStatus }}</span
                >
              </small>
            </div>
            <Button
              v-if="['SCHEDULED', 'QUEUED'].includes(item.state)"
              severity="secondary"
              :disabled="saving"
              @click="cancel(item)"
              >Отменить</Button
            >
          </article>
        </div>
        <div v-else class="empty-state">
          <span aria-hidden="true">◷</span>
          <h3>Расписание пока пусто</h3>
          <p>
            Добавьте первую публикацию — она появится здесь в хронологическом
            порядке.
          </p>
        </div>
      </section>

      <aside class="composer" aria-labelledby="composer-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Новая задача</p>
            <h2 id="composer-title">Запланировать</h2>
          </div>
          <span class="safe-badge">Dry run</span>
        </div>
        <template v-if="!projectId"
          ><p class="hint">Сначала создайте или выберите проект.</p></template
        >
        <template v-else-if="!activeChannel">
          <div class="channel-callout">
            <strong>Подключите безопасный канал</strong>
            <p>
              Dry run проверит расписание и пакет, но ничего не отправит наружу.
            </p>
            <Button :loading="saving" @click="createChannel"
              >Подключить dry run</Button
            >
          </div>
        </template>
        <form v-else class="schedule-form" @submit.prevent="schedule">
          <label
            ><span>Формат контента</span
            ><Select
              v-model="contentKind"
              :options="[
                { label: 'Горизонтальный пакет', value: 'EDITORIAL_EXPORT' },
                { label: 'Вертикальный ролик', value: 'VERTICAL_RESULT' },
              ]"
              option-label="label"
              option-value="value"
          /></label>
          <label v-if="contentKind === 'EDITORIAL_EXPORT'"
            ><span>Готовый пакет</span
            ><Select
              v-model="exportId"
              :options="readyExports"
              option-label="result.filename"
              option-value="id"
              placeholder="Выберите готовый экспорт"
          /></label>
          <p v-if="!readyExports.length" class="hint">
            Нет актуального готового экспорта. Завершите согласование и экспорт
            в контент-плане.
          </p>
          <label v-if="contentKind === 'VERTICAL_RESULT'"
            ><span>Одобренный vertical</span
            ><Select
              v-model="verticalId"
              :options="readyVerticals"
              option-value="id"
              placeholder="Выберите вертикальный ролик"
            >
              <template #option="slotProps">
                9:16 · {{ slotProps.option.result.width }} ×
                {{ slotProps.option.result.height }} ·
                {{ formatDate(slotProps.option.createdAt) }}
              </template>
              <template #value="slotProps">
                <span v-if="slotProps.value"
                  >Одобренный vertical · {{ slotProps.value.slice(0, 8) }}</span
                >
                <span v-else>Выберите вертикальный ролик</span>
              </template>
            </Select></label
          >
          <p
            v-if="contentKind === 'VERTICAL_RESULT' && !readyVerticals.length"
            class="hint"
          >
            Нет одобренных vertical-роликов. Подтвердите готовый результат в
            разделе «Вертикальные».
          </p>
          <label
            ><span>Заголовок</span
            ><InputText
              v-model="title"
              :placeholder="projectName(projectId)"
              maxlength="100"
          /></label>
          <label
            ><span>Описание</span
            ><Textarea
              v-model="description"
              rows="4"
              maxlength="1000"
              placeholder="Коротко опишите выпуск"
          /></label>
          <label
            ><span>Дата и время</span
            ><input
              v-model="scheduledLocal"
              class="native-control"
              type="datetime-local"
              required
          /></label>
          <p class="timezone">
            Часовой пояс: <strong>{{ timezone }}</strong>
          </p>
          <Button
            type="submit"
            :disabled="
              (contentKind === 'EDITORIAL_EXPORT' ? !exportId : !verticalId) ||
              saving
            "
            :loading="saving"
            >Добавить в расписание</Button
          >
        </form>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.publication-page {
  max-width: 92rem;
  min-height: 100vh;
  margin: 0 auto;
  padding: 2rem clamp(1.25rem, 3vw, 3.25rem) 5rem;
}
.page-header,
.section-heading,
.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.25rem;
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
  color: var(--cf-brand-strong);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
h1 {
  margin: 0.18rem 0 0.5rem;
  font-size: clamp(2rem, 3vw, 2.65rem);
  letter-spacing: -0.045em;
  line-height: 1.08;
}
.intro {
  max-width: 44rem;
  margin: 0;
  color: var(--cf-text-muted);
  font-size: 1rem;
}
.project-switcher {
  display: grid;
  min-width: min(22rem, 100%);
  gap: 0.35rem;
}
.project-switcher > span,
.schedule-form label > span {
  font-size: 0.76rem;
  font-weight: 750;
  color: var(--cf-text-muted);
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.8rem;
  margin: 1.75rem 0;
}
.summary article {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.1rem 1rem;
  padding: 1rem 1.1rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: var(--cf-surface);
  box-shadow: var(--cf-shadow-sm);
}
.summary span {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--cf-text-muted);
}
.summary strong {
  grid-row: 1/3;
  grid-column: 2;
  font-size: 1.8rem;
  line-height: 1;
}
.summary small {
  color: var(--cf-text-muted);
}
.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(19rem, 24rem);
  gap: 1rem;
}
.queue-panel,
.composer {
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  background: var(--cf-surface);
  box-shadow: var(--cf-shadow-sm);
}
.queue-panel {
  padding: 1.25rem;
}
.composer {
  align-self: start;
  padding: 1.25rem;
  position: sticky;
  top: 1rem;
}
.section-heading {
  align-items: center;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--cf-border);
}
h2 {
  margin: 0.15rem 0 0;
  font-size: 1.2rem;
  letter-spacing: -0.02em;
}
.publication-list {
  display: grid;
}
.publication-card {
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 1rem 0.25rem;
  border-bottom: 1px solid var(--cf-border);
}
.publication-card:last-child {
  border: 0;
}
.publication-card time {
  display: grid;
}
.publication-card time strong {
  font-size: 0.88rem;
}
.publication-card time small,
.publication-main p,
.publication-main small {
  color: var(--cf-text-muted);
}
.publication-main h3 {
  margin: 0;
  font-size: 0.95rem;
}
.publication-main p {
  margin: 0.25rem 0 0;
}
.status,
.safe-badge {
  padding: 0.28rem 0.5rem;
  border-radius: 999px;
  background: var(--cf-info-soft);
  color: var(--cf-info);
  font-size: 0.7rem;
  font-weight: 800;
}
.status[data-state="DRY_RUN_READY"],
.status[data-state="PUBLISHED"] {
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
.status[data-state="FAILED_FINAL"],
.status[data-state="CANCELED"] {
  background: var(--cf-danger-soft);
  color: var(--cf-danger);
}
.status[data-state="PROCESSING"] {
  background: var(--cf-warning-soft);
  color: var(--cf-warning);
}
.status[data-state="UNKNOWN_REMOTE_STATE"] {
  background: var(--cf-warning-soft);
  color: var(--cf-warning);
}
.reconciliation-note {
  display: block;
  margin-top: 0.45rem;
}
.schedule-form {
  display: grid;
  gap: 0.9rem;
  padding-top: 1rem;
}
.schedule-form label {
  display: grid;
  gap: 0.35rem;
}
.native-control {
  width: 100%;
  min-height: var(--cf-control-height);
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--cf-border-strong);
  border-radius: var(--cf-radius-sm);
  background: #fff;
  color: var(--cf-text);
}
.timezone,
.hint {
  margin: 0;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
}
.channel-callout,
.empty-state {
  padding: 2rem 1rem;
  text-align: center;
}
.channel-callout p,
.empty-state p {
  color: var(--cf-text-muted);
}
.empty-state > span {
  display: grid;
  width: 3rem;
  height: 3rem;
  margin: 0 auto 0.8rem;
  place-items: center;
  border-radius: 1rem;
  background: var(--cf-brand-soft);
  color: var(--cf-brand);
  font-size: 1.4rem;
}
.empty-state h3 {
  margin: 0;
}
.empty-state p {
  max-width: 25rem;
  margin: 0.35rem auto;
}
.empty {
  padding: 2rem;
  color: var(--cf-text-muted);
  text-align: center;
}
.message {
  padding: 0.75rem 1rem;
  border-radius: var(--cf-radius-sm);
}
.message.error {
  background: var(--cf-danger-soft);
  color: var(--cf-danger);
}
.message.success {
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
@media (max-width: 1100px) {
  .summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .composer {
    position: static;
    grid-row: 1;
  }
}
@media (max-width: 700px) {
  .page-header {
    display: grid;
  }
  .project-switcher {
    min-width: 0;
  }
  .summary {
    grid-template-columns: 1fr;
  }
  .publication-card {
    grid-template-columns: 1fr;
  }
  .publication-card time {
    display: flex;
    justify-content: space-between;
  }
  .title-row {
    display: grid;
    gap: 0.4rem;
  }
  .status {
    width: max-content;
  }
}
</style>
