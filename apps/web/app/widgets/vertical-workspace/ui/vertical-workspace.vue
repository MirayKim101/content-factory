<script setup lang="ts">
import Button from "primevue/button";
import Select from "primevue/select";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import {
  createMediaPipelineApi,
  type PipelineJob,
} from "~/shared/api/media-pipeline";
import { createProjectsApi, listAllProjects } from "~/shared/api/projects";
import {
  createVerticalRendersApi,
  type VerticalRender,
} from "~/shared/api/vertical-renders";
import {
  hasActiveVerticalRender,
  hasBlockingVerticalRender,
} from "~/widgets/vertical-workspace/model/availability";

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const cutsApi = createMediaPipelineApi(config.public.apiBasePath);
const verticalApi = createVerticalRendersApi(config.public.apiBasePath);
const projects = ref<Array<{ id: string; name: string }>>([]);
const projectId = ref("");
const cuts = ref<PipelineJob[]>([]);
const renders = ref<VerticalRender[]>([]);
const renderEnabled = ref(false);
const selectedCutId = ref("");
const loading = ref(true);
const refreshing = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const initialized = ref(false);

const readyCuts = computed(() =>
  cuts.value.filter((cut) => cut.state === "READY" && cut.result),
);
const availableCuts = computed(() =>
  readyCuts.value.filter(
    (cut) => !hasBlockingVerticalRender(cut.id, renders.value),
  ),
);
const summary = computed(() => ({
  queued: renders.value.filter((item) =>
    ["QUEUED", "RETRY_WAIT"].includes(item.job.state),
  ).length,
  processing: renders.value.filter((item) => item.job.state === "PROCESSING")
    .length,
  ready: renders.value.filter((item) => item.job.state === "READY").length,
  attention: renders.value.filter((item) => item.job.state === "FAILED_FINAL")
    .length,
}));

async function loadProjects() {
  const allProjects = await listAllProjects(projectsApi);
  projects.value = allProjects.map(({ id, name }) => ({ id, name }));
  const requested =
    typeof route.query.projectId === "string" ? route.query.projectId : "";
  projectId.value = projects.value.some((item) => item.id === requested)
    ? requested
    : (projects.value[0]?.id ?? "");
}
async function loadWorkspace() {
  if (!projectId.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const [jobs, items] = await Promise.all([
      cutsApi.listProjectJobs(projectId.value),
      verticalApi.list(projectId.value),
    ]);
    cuts.value = jobs.items;
    renders.value = items;
    if (!availableCuts.value.some((cut) => cut.id === selectedCutId.value))
      selectedCutId.value = availableCuts.value[0]?.id ?? "";
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось загрузить вертикальные ролики.";
  } finally {
    loading.value = false;
  }
}
async function refreshWorkspace() {
  const selectedProjectId = projectId.value;
  if (
    !selectedProjectId ||
    loading.value ||
    saving.value ||
    refreshing.value ||
    document.hidden
  )
    return;
  refreshing.value = true;
  try {
    const [jobs, items] = await Promise.all([
      cutsApi.listProjectJobs(selectedProjectId),
      verticalApi.list(selectedProjectId),
    ]);
    if (projectId.value !== selectedProjectId) return;
    cuts.value = jobs.items;
    renders.value = items;
    if (!availableCuts.value.some((cut) => cut.id === selectedCutId.value))
      selectedCutId.value = availableCuts.value[0]?.id ?? "";
  } catch {
    // Background refresh stays silent; manual refresh surfaces errors.
  } finally {
    refreshing.value = false;
  }
}
async function createRender() {
  if (
    !renderEnabled.value ||
    !projectId.value ||
    !selectedCutId.value ||
    saving.value
  )
    return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await verticalApi.create(
      projectId.value,
      selectedCutId.value,
      `vertical-ui-${crypto.randomUUID()}`,
    );
    notice.value = "Вертикальная версия добавлена в очередь.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось создать вертикальную версию.";
  } finally {
    saving.value = false;
  }
}
async function approve(item: VerticalRender) {
  if (saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await verticalApi.approve(item.id);
    notice.value = "Вертикальная версия подтверждена.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось подтвердить результат.";
  } finally {
    saving.value = false;
  }
}
function stateLabel(state: VerticalRender["job"]["state"]) {
  return (
    {
      QUEUED: "В очереди",
      PROCESSING: "Рендер",
      RETRY_WAIT: "Повтор",
      READY: "Готово",
      FAILED_FINAL: "Ошибка",
    } as const
  )[state];
}
function cutLabel(cut: PipelineJob | undefined) {
  if (!cut) return "Нарезка больше не доступна";
  return `Нарезка ${cut.startMs / 1000}–${cut.endMs / 1000} сек. · ${cut.result?.filename ?? cut.id.slice(0, 8)}`;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function formatBytes(value?: string) {
  if (!value) return "—";
  const bytes = Number(value);
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} МБ`
    : `${Math.ceil(bytes / 1024)} КБ`;
}

watch(projectId, () => {
  if (initialized.value) void loadWorkspace();
});
let refreshTimer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  try {
    const [capabilities] = await Promise.all([
      verticalApi.capabilities(),
      loadProjects(),
    ]);
    renderEnabled.value = capabilities.renderEnabled;
    initialized.value = true;
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось загрузить проекты.";
    loading.value = false;
  }
  refreshTimer = setInterval(() => {
    if (hasActiveVerticalRender(renders.value)) void refreshWorkspace();
  }, 5000);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <main class="vertical-page" aria-labelledby="vertical-title">
    <header class="page-header">
      <div>
        <nav class="breadcrumbs" aria-label="Хлебные крошки">
          <span>Производство</span><span>/</span><strong>Вертикальные</strong>
        </nav>
        <p class="eyebrow">Форматы · 9:16</p>
        <h1 id="vertical-title">Вертикальные версии</h1>
        <p class="intro">
          Превращайте готовые нарезки в ролики 1080 × 1920 и подтверждайте их
          перед публикацией.
        </p>
      </div>
      <label class="project-switcher"
        ><span>Проект</span
        ><Select
          v-model="projectId"
          :options="projects"
          option-label="name"
          option-value="id"
          placeholder="Выберите проект"
      /></label>
    </header>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <section class="summary" aria-label="Сводка">
      <article>
        <span>В очереди</span><strong>{{ summary.queued }}</strong>
      </article>
      <article>
        <span>Рендерится</span><strong>{{ summary.processing }}</strong>
      </article>
      <article>
        <span>Готово</span><strong>{{ summary.ready }}</strong>
      </article>
      <article>
        <span>Внимание</span><strong>{{ summary.attention }}</strong>
      </article>
    </section>
    <div class="workspace-grid">
      <section class="queue-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Операционная очередь</p>
            <h2>Вертикальные ролики</h2>
          </div>
          <Button
            severity="secondary"
            :disabled="loading"
            @click="loadWorkspace"
            >Обновить</Button
          >
        </div>
        <p v-if="loading" class="empty">Обновляем очередь…</p>
        <div v-else-if="renders.length" class="render-list">
          <article v-for="item in renders" :key="item.id" class="render-card">
            <div class="portrait" aria-hidden="true"><span>9:16</span></div>
            <div class="render-main">
              <div class="title-row">
                <h3>
                  {{
                    cutLabel(
                      cuts.find((cut) => cut.id === item.cutPipelineJobId),
                    )
                  }}
                </h3>
                <span class="status" :data-state="item.job.state">{{
                  stateLabel(item.job.state)
                }}</span>
              </div>
              <p>
                1080 × 1920 · центрированный кадр ·
                {{
                  item.result
                    ? formatBytes(item.result.sizeBytes)
                    : `попытка ${item.job.attemptCount}/${item.job.retryBudget + 1}`
                }}
              </p>
              <small>Создано {{ formatDate(item.createdAt) }}</small
              ><small v-if="item.job.failureMessage" class="failure">{{
                item.job.failureMessage
              }}</small>
            </div>
            <div v-if="item.result" class="render-actions">
              <a
                class="preview-link"
                :href="item.result.downloadUrl"
                target="_blank"
                rel="noopener"
                >Открыть видео</a
              >
              <span v-if="item.result.approval" class="approved"
                >✓ Подтверждено</span
              >
              <Button v-else :disabled="saving" @click="approve(item)"
                >Подтвердить</Button
              >
            </div>
          </article>
        </div>
        <div v-else class="empty-state">
          <span class="empty-ratio" aria-hidden="true">9:16</span>
          <h3>Вертикальных версий пока нет</h3>
          <p>Выберите готовую нарезку справа, чтобы создать первую версию.</p>
        </div>
      </section>
      <aside class="composer">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Новая задача</p>
            <h2>Создать 9:16</h2>
          </div>
          <span class="format-badge">1080 × 1920</span>
        </div>
        <p class="hint">
          Исходник не изменяется. Результат сохраняется отдельным артефактом и
          требует подтверждения.
        </p>
        <p v-if="!renderEnabled" class="admission-note" role="status">
          Создание новых вертикальных версий выключено администратором.
          Готовые результаты по-прежнему доступны для просмотра и подтверждения.
        </p>
        <label
          ><span>Готовая нарезка</span
          ><Select
            v-model="selectedCutId"
            :disabled="!renderEnabled"
            :options="availableCuts"
            option-value="id"
            :option-label="cutLabel"
            placeholder="Выберите нарезку"
        /></label>
        <div class="contract">
          <span>Кадрирование</span><strong>По центру</strong><span>Кодек</span
          ><strong>H.264 / AAC</strong><span>Контроль</span
          ><strong>Ручное подтверждение</strong>
        </div>
        <Button
          :disabled="!renderEnabled || !selectedCutId || saving"
          @click="createRender"
          >{{
          saving ? "Создаём…" : "Добавить в очередь"
        }}</Button>
        <p v-if="!loading && !availableCuts.length" class="hint">
          Все готовые нарезки уже добавлены или ещё не созданы.
        </p>
        <p
          v-else-if="renders.some((item) => item.job.state === 'FAILED_FINAL')"
          class="hint"
        >
          После финальной ошибки можно выбрать исходную нарезку повторно. Новая
          попытка сохранит предыдущую запись в истории.
        </p>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.vertical-page {
  max-width: 90rem;
  margin: 0 auto;
  padding: 2.3rem 2.5rem 5rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
  align-items: flex-end;
  margin-bottom: 1.5rem;
}
.breadcrumbs {
  display: flex;
  gap: 0.55rem;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
}
.eyebrow {
  margin: 0.65rem 0 0.25rem;
  color: var(--cf-brand-strong);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3rem);
  letter-spacing: -0.045em;
}
h2,
h3 {
  margin: 0;
}
.intro {
  max-width: 44rem;
  margin: 0.45rem 0 0;
  color: var(--cf-text-muted);
}
.admission-note {
  margin: 0;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
  font-size: 0.78rem;
}
.project-switcher {
  width: min(22rem, 100%);
}
label > span {
  display: block;
  margin-bottom: 0.35rem;
  color: var(--cf-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin: 1rem 0;
}
.summary article {
  padding: 1rem 1.1rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: #fff;
}
.summary span {
  display: block;
  color: var(--cf-text-muted);
  font-size: 0.75rem;
}
.summary strong {
  font-size: 1.65rem;
}
.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(18rem, 0.75fr);
  gap: 1rem;
}
.queue-panel,
.composer {
  padding: 1.25rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  background: #fff;
  box-shadow: var(--cf-shadow-sm);
}
.composer {
  align-self: start;
  position: sticky;
  top: 1rem;
}
.section-heading,
.title-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
}
.render-list {
  display: grid;
  gap: 0.65rem;
  margin-top: 1.15rem;
}
.render-card {
  display: grid;
  grid-template-columns: 3.25rem minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding: 0.9rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
}
.portrait {
  display: grid;
  width: 2.5rem;
  height: 4.4rem;
  place-items: center;
  border-radius: 0.5rem;
  background: linear-gradient(160deg, #202a46, #4f5fd7);
  color: #fff;
  font-size: 0.65rem;
  font-weight: 800;
}
.render-main p,
.render-main small {
  display: block;
  margin: 0.25rem 0 0;
  color: var(--cf-text-muted);
}
.status,
.approved,
.format-badge {
  padding: 0.28rem 0.55rem;
  border-radius: 999px;
  background: var(--cf-brand-soft);
  color: var(--cf-brand-strong);
  font-size: 0.72rem;
  font-weight: 800;
}
.status[data-state="READY"],
.approved {
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
.status[data-state="FAILED_FINAL"] {
  background: var(--cf-danger-soft);
  color: var(--cf-danger);
}
.failure {
  color: var(--cf-danger) !important;
}
.render-actions {
  display: grid;
  gap: 0.45rem;
  justify-items: end;
}
.preview-link {
  font-size: 0.78rem;
  font-weight: 750;
}
.composer label {
  display: block;
  margin: 1.25rem 0;
}
.contract {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.6rem;
  padding: 1rem;
  margin-bottom: 1rem;
  border-radius: var(--cf-radius-md);
  background: var(--cf-surface-subtle);
  font-size: 0.78rem;
}
.contract span,
.hint {
  color: var(--cf-text-muted);
}
.composer :deep(.p-button) {
  width: 100%;
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
.empty,
.empty-state {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--cf-text-muted);
}
.empty-ratio {
  display: grid;
  width: 2.5rem;
  height: 3.75rem;
  margin: 0 auto 0.75rem;
  place-items: center;
  border: 2px solid var(--cf-border-strong);
  border-radius: 0.6rem;
  background: var(--cf-surface-subtle);
  color: var(--cf-brand-strong);
  font-size: 0.68rem;
  font-weight: 800;
}
@media (max-width: 900px) {
  .vertical-page {
    padding: 1.25rem;
  }
  .page-header {
    align-items: stretch;
    flex-direction: column;
  }
  .summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .composer {
    position: static;
  }
  .render-card {
    grid-template-columns: 2.75rem minmax(0, 1fr);
  }
  .render-card > :last-child {
    grid-column: 2;
  }
}
@media (max-width: 520px) {
  .summary {
    grid-template-columns: 1fr 1fr;
  }
  .title-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
