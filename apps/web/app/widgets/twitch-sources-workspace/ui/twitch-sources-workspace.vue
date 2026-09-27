<script setup lang="ts">
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { computed, onMounted, onUnmounted, ref } from "vue";

import { createProjectsApi, listAllProjects } from "~/shared/api/projects";
import {
  createTwitchSourcesApi,
  type TwitchSourceChannel,
  type TwitchVodCandidate,
} from "~/shared/api/twitch-sources";

const config = useRuntimeConfig();
const api = createTwitchSourcesApi(config.public.apiBasePath);
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const channels = ref<TwitchSourceChannel[]>([]);
const ingestionEnabled = ref(false);
const autoIngestEnabled = ref(false);
const vodCandidates = ref<TwitchVodCandidate[]>([]);
const sourceReadyProjects = ref<{ label: string; value: string }[]>([]);
const selectedProjects = ref<Record<string, string>>({});
const sourceMatchConfirmations = ref<Record<string, boolean>>({});
const importNames = ref<Record<string, string>>({});
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const broadcasterId = ref("");
const broadcasterLogin = ref("");
const broadcasterDisplayName = ref("");
const delayMinutes = ref(5);
const enabled = computed(() =>
  channels.value.filter((item) => item.state === "ENABLED"),
);
const synced = computed(
  () => channels.value.filter((item) => item.lastReconciledAt).length,
);
const readyVodCount = computed(
  () =>
    vodCandidates.value.filter((item) => item.state === "READY_FOR_INGEST")
      .length,
);
const valid = computed(
  () =>
    /^\d{1,64}$/.test(broadcasterId.value.trim()) &&
    /^[a-zA-Z0-9_]{1,64}$/.test(broadcasterLogin.value.trim()) &&
    broadcasterDisplayName.value.trim().length > 0 &&
    delayMinutes.value >= 1 &&
    delayMinutes.value <= 1440,
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [capabilities, nextChannels, nextVodCandidates, allProjects] =
      await Promise.all([
        api.capabilities(),
        api.list(),
        api.listVodCandidates(),
        listAllProjects(projectsApi, { status: "SOURCE_READY" }),
      ]);
    ingestionEnabled.value = capabilities.ingestionEnabled;
    autoIngestEnabled.value = capabilities.autoIngestEnabled;
    channels.value = nextChannels;
    vodCandidates.value = nextVodCandidates;
    const linkedProjectIds = new Set(
      nextVodCandidates.flatMap((candidate) =>
        candidate.importedProjectId ? [candidate.importedProjectId] : [],
      ),
    );
    sourceReadyProjects.value = allProjects
      .filter((project) => !linkedProjectIds.has(project.id))
      .map((project) => ({
        label: project.name,
        value: project.id,
      }));
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось загрузить источники.";
  } finally {
    loading.value = false;
  }
}
async function linkProject(item: TwitchVodCandidate) {
  const projectId = selectedProjects.value[item.id];
  if (!projectId || !sourceMatchConfirmations.value[item.id] || saving.value)
    return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.linkVodProject(item.id, projectId, true);
    notice.value = "Запись Twitch привязана к проекту.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось привязать проект.";
  } finally {
    saving.value = false;
  }
}
async function startAutomaticImport(item: TwitchVodCandidate) {
  if (saving.value || item.ingestIntent) return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.startVodImport(
      item.id,
      importNames.value[item.id]?.trim() || item.title,
      `twitch-vod:${item.id}:${crypto.randomUUID()}`,
    );
    notice.value =
      "Импорт поставлен в очередь. Права нужно подтвердить после загрузки.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось начать импорт.";
  } finally {
    saving.value = false;
  }
}
async function retryAutomaticImport(item: TwitchVodCandidate) {
  if (saving.value || item.ingestIntent?.state !== "FAILED_FINAL") return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.retryVodImport(item.ingestIntent.id);
    notice.value = "Повторный импорт поставлен в очередь.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось повторить импорт.";
  } finally {
    saving.value = false;
  }
}
async function save() {
  if (!ingestionEnabled.value || !valid.value || saving.value) return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.save({
      broadcasterId: broadcasterId.value.trim(),
      broadcasterLogin: broadcasterLogin.value.trim().toLowerCase(),
      broadcasterDisplayName: broadcasterDisplayName.value.trim(),
      ingestDelaySeconds: Math.round(delayMinutes.value * 60),
    });
    broadcasterId.value = "";
    broadcasterLogin.value = "";
    broadcasterDisplayName.value = "";
    delayMinutes.value = 5;
    notice.value = "Канал добавлен в разрешённые источники.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось сохранить канал.";
  } finally {
    saving.value = false;
  }
}
async function revoke(item: TwitchSourceChannel) {
  if (
    saving.value ||
    !confirm(
      `Отозвать источник ${item.broadcasterDisplayName}? История синхронизации сохранится.`,
    )
  )
    return;
  saving.value = true;
  error.value = null;
  try {
    await api.revoke(item.id);
    notice.value = "Доступ источника отозван.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось отозвать источник.";
  } finally {
    saving.value = false;
  }
}
async function ignoreVod(item: TwitchVodCandidate) {
  if (
    saving.value ||
    !confirm(`Пропустить запись «${item.title}»? История останется в журнале.`)
  )
    return;
  saving.value = true;
  error.value = null;
  try {
    await api.ignoreVodCandidate(item.id);
    notice.value = "Запись исключена из очереди импорта.";
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось пропустить запись.";
  } finally {
    saving.value = false;
  }
}
function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "Ещё не выполнялась";
}
function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}
function twitchVodUrl(providerVideoId: string) {
  return `https://www.twitch.tv/videos/${encodeURIComponent(providerVideoId)}`;
}
function vodStateLabel(state: TwitchVodCandidate["state"]) {
  return (
    {
      WAITING_DELAY: "Задержка",
      READY_FOR_INGEST: "Готов к импорту",
      IMPORTED: "Импортирован",
      IGNORED: "Пропущен",
    } as const
  )[state];
}
function ingestStateLabel(
  state: NonNullable<TwitchVodCandidate["ingestIntent"]>["state"],
) {
  return (
    {
      QUEUED: "В очереди",
      DOWNLOADING: "Скачивание",
      UPLOADING: "Загрузка в хранилище",
      RETRY_WAIT: "Повтор после сбоя",
      READY: "Импорт завершён",
      FAILED_FINAL: "Импорт остановлен",
      CANCELED: "Отменён",
    } as const
  )[state];
}
function ingestProgress(item: NonNullable<TwitchVodCandidate["ingestIntent"]>) {
  if (!item.totalBytes || item.totalBytes === "0") return null;
  return Math.min(
    100,
    Math.round((Number(item.downloadedBytes) / Number(item.totalBytes)) * 100),
  );
}
let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  pollTimer = setInterval(() => {
    if (
      !saving.value &&
      vodCandidates.value.some(
        (item) =>
          item.ingestIntent &&
          ["QUEUED", "DOWNLOADING", "UPLOADING", "RETRY_WAIT"].includes(
            item.ingestIntent.state,
          ),
      )
    )
      void load();
  }, 5000);
});
onUnmounted(() => pollTimer && clearInterval(pollTimer));
</script>

<template>
  <main class="sources-page" aria-labelledby="sources-title">
    <header class="page-header">
      <div>
        <nav class="breadcrumbs" aria-label="Хлебные крошки">
          <span>Производство</span><span>/</span
          ><strong>Источники Twitch</strong>
        </nav>
        <p class="eyebrow">Ingestion · Allowlist</p>
        <h1 id="sources-title">Источники Twitch</h1>
        <p class="intro">
          Управляйте каналами, чьи записи можно принимать в Content Factory.
          Доступ можно отозвать без удаления истории.
        </p>
      </div>
      <Button severity="secondary" :disabled="loading" @click="load"
        >Обновить</Button
      >
    </header>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <section class="summary">
      <article>
        <span>Разрешено</span><strong>{{ enabled.length }}</strong
        ><small>активных каналов</small>
      </article>
      <article>
        <span>Всего</span><strong>{{ channels.length }}</strong
        ><small>включая отозванные</small>
      </article>
      <article>
        <span>Синхронизировано</span><strong>{{ synced }}</strong
        ><small>имеют результат сверки</small>
      </article>
      <article>
        <span>Готово к импорту</span><strong>{{ readyVodCount }}</strong
        ><small>записей после задержки</small>
      </article>
    </section>
    <div class="workspace-grid">
      <section class="list-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Реестр</p>
            <h2>Разрешённые каналы</h2>
          </div>
        </div>
        <p v-if="loading" class="empty">Загружаем реестр…</p>
        <div v-else-if="channels.length" class="channel-list">
          <article v-for="item in channels" :key="item.id" class="channel-card">
            <span class="avatar" aria-hidden="true">{{
              item.broadcasterDisplayName.slice(0, 1).toUpperCase()
            }}</span>
            <div>
              <div class="title-row">
                <h3>{{ item.broadcasterDisplayName }}</h3>
                <span class="status" :data-state="item.state">{{
                  item.state === "ENABLED" ? "Разрешён" : "Отозван"
                }}</span>
              </div>
              <p>
                @{{ item.broadcasterLogin }} · Twitch ID
                {{ item.broadcasterId }}
              </p>
              <small
                >Задержка {{ item.ingestDelaySeconds / 60 }} мин · Сверка:
                {{ formatDate(item.lastReconciledAt) }}</small
              >
            </div>
            <Button
              v-if="item.state === 'ENABLED'"
              severity="secondary"
              :disabled="saving"
              @click="revoke(item)"
              >Отозвать</Button
            >
          </article>
        </div>
        <div v-else class="empty">
          <h3>Источники не добавлены</h3>
          <p>Добавьте первый Twitch-канал справа.</p>
        </div>
      </section>
      <section class="vod-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Архив эфиров</p>
            <h2>Найденные записи</h2>
          </div>
          <small>Последние {{ vodCandidates.length }} из 200</small>
        </div>
        <div v-if="vodCandidates.length" class="vod-list">
          <article v-for="vod in vodCandidates" :key="vod.id" class="vod-card">
            <div>
              <div class="title-row">
                <h3>{{ vod.title }}</h3>
                <span class="status vod-status" :data-state="vod.state">{{
                  vodStateLabel(vod.state)
                }}</span>
              </div>
              <p>
                @{{ vod.channel.broadcasterLogin }} · VOD
                {{ vod.providerVideoId }}
              </p>
              <small
                >{{ formatDate(vod.publishedAt) }} ·
                {{ formatDuration(vod.durationSeconds) }} ·
                <a
                  class="vod-link"
                  :href="twitchVodUrl(vod.providerVideoId)"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Открыть оригинал ↗</a
                ></small
              >
            </div>
            <div class="vod-actions">
              <div
                v-if="vod.state === 'READY_FOR_INGEST'"
                class="ingest-action"
              >
                <p class="ingest-note">
                  Запустите защищённый автоматический импорт или привяжите уже
                  загруженный исходник вручную.
                </p>
                <div v-if="vod.ingestIntent" class="automatic-import-status">
                  <strong>{{
                    ingestStateLabel(vod.ingestIntent.state)
                  }}</strong>
                  <span v-if="ingestProgress(vod.ingestIntent) !== null">
                    {{ ingestProgress(vod.ingestIntent) }}%
                  </span>
                  <small v-if="vod.ingestIntent.failureCode">
                    {{ vod.ingestIntent.failureCode }}. Повторите после проверки
                    gateway.
                  </small>
                  <Button
                    v-if="vod.ingestIntent.state === 'FAILED_FINAL'"
                    severity="secondary"
                    :disabled="saving || !autoIngestEnabled"
                    @click="retryAutomaticImport(vod)"
                    >Повторить импорт</Button
                  >
                </div>
                <div
                  v-else-if="autoIngestEnabled"
                  class="automatic-import-action"
                >
                  <InputText
                    v-model="importNames[vod.id]"
                    :placeholder="vod.title"
                    aria-label="Название нового проекта"
                  />
                  <Button :disabled="saving" @click="startAutomaticImport(vod)">
                    Импортировать автоматически
                  </Button>
                </div>
                <small v-else class="automatic-import-disabled">
                  Автоимпорт сейчас выключен. Ручная загрузка и привязка
                  доступны без Twitch media gateway.
                </small>
                <div v-if="sourceReadyProjects.length" class="project-linker">
                  <Select
                    v-model="selectedProjects[vod.id]"
                    :options="sourceReadyProjects"
                    option-label="label"
                    option-value="value"
                    placeholder="Выберите проект"
                    aria-label="Проект с исходником записи"
                  />
                  <label class="source-match-confirmation">
                    <Checkbox
                      v-model="sourceMatchConfirmations[vod.id]"
                      binary
                    />
                    <span
                      >Подтверждаю: исходник в проекте — именно эта запись
                      Twitch.</span
                    >
                  </label>
                  <Button
                    :disabled="
                      saving ||
                      !selectedProjects[vod.id] ||
                      !sourceMatchConfirmations[vod.id]
                    "
                    @click="linkProject(vod)"
                    >Привязать</Button
                  >
                </div>
                <small v-else>
                  Нет свободных проектов с готовым исходником. Загрузите видео в
                  медиатеку, затем вернитесь сюда.
                </small>
              </div>
              <NuxtLink
                v-else-if="vod.importedProjectId"
                :to="`/horizontal?projectIds=${vod.importedProjectId}`"
              >
                Открыть проект
              </NuxtLink>
              <Button
                v-if="
                  ['WAITING_DELAY', 'READY_FOR_INGEST'].includes(vod.state) &&
                  (!vod.ingestIntent ||
                    [
                      'QUEUED',
                      'RETRY_WAIT',
                      'FAILED_FINAL',
                      'CANCELED',
                    ].includes(vod.ingestIntent.state))
                "
                severity="secondary"
                :disabled="saving"
                @click="ignoreVod(vod)"
                >{{
                  vod.ingestIntent ? "Отменить и пропустить" : "Пропустить"
                }}</Button
              >
            </div>
          </article>
        </div>
        <p v-else class="empty">
          Записи появятся после первого завершённого эфира и сверки с Twitch.
        </p>
      </section>
      <aside class="composer">
        <p class="eyebrow">Новый источник</p>
        <h2>Разрешить канал</h2>
        <p class="hint">
          Используйте числовой broadcaster ID из Twitch API. Login нужен только
          для отображения и может изменяться.
        </p>
        <p v-if="!ingestionEnabled" class="admission-note" role="status">
          Подключение новых каналов выключено администратором. Существующие
          источники и история доступны для просмотра и отзыва.
        </p>
        <form @submit.prevent="save">
          <label
            ><span>Broadcaster ID</span
            ><InputText
              v-model="broadcasterId"
              :disabled="!ingestionEnabled"
              inputmode="numeric"
              placeholder="Например, 141981764" /></label
          ><label
            ><span>Login</span
            ><InputText
              v-model="broadcasterLogin"
              :disabled="!ingestionEnabled"
              placeholder="channel_login" /></label
          ><label
            ><span>Название канала</span
            ><InputText
              v-model="broadcasterDisplayName"
              :disabled="!ingestionEnabled"
              placeholder="Название для команды" /></label
          ><label
            ><span>Задержка после эфира, минут</span
            ><input
              v-model.number="delayMinutes"
              class="number-input"
              type="number"
              :disabled="!ingestionEnabled"
              min="1"
              max="1440" /></label
          ><Button
            type="submit"
            :disabled="!ingestionEnabled || !valid || saving"
            >{{
            saving ? "Сохраняем…" : "Разрешить источник"
          }}</Button>
        </form>
        <p class="security-note">
          Токены и EventSub secret на этой странице не вводятся и не
          отображаются.
        </p>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.sources-page {
  max-width: 90rem;
  margin: 0 auto;
  padding: 2.3rem 2.5rem 5rem;
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
.page-header,
.section-heading,
.title-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
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
.intro,
.hint,
.channel-card p,
.channel-card small {
  color: var(--cf-text-muted);
}
.intro {
  max-width: 47rem;
  margin: 0.45rem 0 0;
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin: 1.5rem 0 1rem;
}
.summary article,
.list-panel,
.vod-panel,
.composer {
  border: 1px solid var(--cf-border);
  background: #fff;
  box-shadow: var(--cf-shadow-sm);
}
.summary article {
  padding: 1rem 1.1rem;
  border-radius: var(--cf-radius-md);
}
.summary span,
.summary small {
  display: block;
  color: var(--cf-text-muted);
  font-size: 0.75rem;
}
.summary strong {
  font-size: 1.65rem;
}
.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(18rem, 0.7fr);
  gap: 1rem;
}
.list-panel,
.vod-panel,
.composer {
  padding: 1.25rem;
  border-radius: var(--cf-radius-lg);
}
.vod-panel {
  grid-column: 1;
}
.vod-list {
  display: grid;
  gap: 0.65rem;
  margin-top: 1rem;
}
.vod-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(12rem, 18rem);
  gap: 1rem;
  padding: 0.9rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
}
.vod-card p,
.vod-card small,
.section-heading > small {
  margin: 0.25rem 0 0;
  color: var(--cf-text-muted);
}
.vod-link {
  color: var(--cf-brand-strong);
  font-weight: 750;
  text-decoration: none;
}
.vod-link:hover,
.vod-link:focus-visible {
  text-decoration: underline;
}
.ingest-note {
  font-size: 0.78rem;
}
.ingest-action {
  display: grid;
  gap: 0.65rem;
  align-self: center;
}
.automatic-import-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  padding: 0.65rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-subtle);
}
.automatic-import-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  padding: 0.65rem;
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-subtle);
}
.automatic-import-status small {
  flex-basis: 100%;
  color: var(--cf-danger);
}
.automatic-import-disabled {
  padding: 0.6rem 0.7rem;
  border-left: 3px solid var(--cf-border-strong);
  color: var(--cf-text-muted);
}
.vod-actions {
  display: grid;
  gap: 0.65rem;
  align-content: center;
  justify-items: stretch;
}
.project-linker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
}
.source-match-confirmation {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  color: var(--cf-text);
  font-size: 0.76rem;
  line-height: 1.35;
  cursor: pointer;
}
.vod-status[data-state="WAITING_DELAY"] {
  background: var(--cf-warning-soft);
  color: var(--cf-warning);
}
.vod-status[data-state="IGNORED"] {
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
}
.composer {
  align-self: start;
  position: sticky;
  top: 1rem;
  grid-column: 2;
  grid-row: 1 / span 2;
}
.channel-list {
  display: grid;
  gap: 0.65rem;
  margin-top: 1rem;
}
.channel-card {
  display: grid;
  grid-template-columns: 2.7rem minmax(0, 1fr) auto;
  gap: 0.9rem;
  align-items: center;
  padding: 0.9rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
}
.avatar {
  display: grid;
  width: 2.7rem;
  height: 2.7rem;
  place-items: center;
  border-radius: 0.75rem;
  background: #f0ebff;
  color: #6441a5;
  font-weight: 850;
}
.channel-card p,
.channel-card small {
  display: block;
  margin: 0.2rem 0 0;
}
.status {
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: var(--cf-success-soft);
  color: var(--cf-success);
  font-size: 0.72rem;
  font-weight: 800;
}
.status[data-state="REVOKED"] {
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
}
form,
label {
  display: grid;
  gap: 0.35rem;
}
form {
  gap: 0.9rem;
  margin-top: 1rem;
}
label span {
  color: var(--cf-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}
.number-input {
  width: 100%;
  min-height: var(--cf-control-height);
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--cf-border-strong);
  border-radius: var(--cf-radius-sm);
}
.security-note {
  padding: 0.8rem;
  margin: 1rem 0 0;
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-subtle);
  color: var(--cf-text-muted);
  font-size: 0.75rem;
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
.empty {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--cf-text-muted);
}
@media (max-width: 850px) {
  .sources-page {
    padding: 1.25rem;
  }
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .summary {
    grid-template-columns: 1fr;
  }
  .vod-card {
    grid-template-columns: 1fr;
  }
  .automatic-import-action {
    grid-template-columns: 1fr;
  }
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .composer {
    position: static;
    grid-column: auto;
    grid-row: auto;
  }
  .channel-card {
    grid-template-columns: 2.7rem minmax(0, 1fr);
  }
  .channel-card > :last-child {
    grid-column: 2;
  }
}
</style>
