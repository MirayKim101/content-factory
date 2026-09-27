<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, ref } from "vue";

import {
  createTwitchSourcesApi,
  type TwitchSourceChannel,
  type TwitchVodCandidate,
} from "~/shared/api/twitch-sources";

const config = useRuntimeConfig();
const api = createTwitchSourcesApi(config.public.apiBasePath);
const channels = ref<TwitchSourceChannel[]>([]);
const vodCandidates = ref<TwitchVodCandidate[]>([]);
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
    [channels.value, vodCandidates.value] = await Promise.all([
      api.list(),
      api.listVodCandidates(),
    ]);
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось загрузить источники.";
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!valid.value || saving.value) return;
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
onMounted(load);
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
                {{ formatDuration(vod.durationSeconds) }}</small
              >
            </div>
            <p v-if="vod.state === 'READY_FOR_INGEST'" class="ingest-note">
              Метаданные готовы. Для загрузки медиа требуется настроенный
              provider adapter.
            </p>
            <NuxtLink
              v-else-if="vod.importedProjectId"
              :to="`/horizontal?projectIds=${vod.importedProjectId}`"
            >
              Открыть проект
            </NuxtLink>
            <Button
              v-if="['WAITING_DELAY', 'READY_FOR_INGEST'].includes(vod.state)"
              severity="secondary"
              :disabled="saving"
              @click="ignoreVod(vod)"
              >Пропустить</Button
            >
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
        <form @submit.prevent="save">
          <label
            ><span>Broadcaster ID</span
            ><InputText
              v-model="broadcasterId"
              inputmode="numeric"
              placeholder="Например, 141981764" /></label
          ><label
            ><span>Login</span
            ><InputText
              v-model="broadcasterLogin"
              placeholder="channel_login" /></label
          ><label
            ><span>Название канала</span
            ><InputText
              v-model="broadcasterDisplayName"
              placeholder="Название для команды" /></label
          ><label
            ><span>Задержка после эфира, минут</span
            ><input
              v-model.number="delayMinutes"
              class="number-input"
              type="number"
              min="1"
              max="1440" /></label
          ><Button type="submit" :disabled="!valid || saving">{{
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
.ingest-note {
  align-self: center;
  font-size: 0.78rem;
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
