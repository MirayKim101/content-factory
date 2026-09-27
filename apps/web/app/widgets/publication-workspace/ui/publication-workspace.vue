<script setup lang="ts">
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import {
  createEditorialExportsApi,
  type EditorialExport,
} from "~/shared/api/editorial-exports";
import { createProjectsApi } from "~/shared/api/projects";
import {
  createPublicationsApi,
  type PublicationChannel,
  type PublicationIntent,
  type TikTokCreatorInfo,
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
const refreshingPublications = ref(false);
const exportId = ref("");
const contentKind = ref<"EDITORIAL_EXPORT" | "VERTICAL_RESULT">(
  "EDITORIAL_EXPORT",
);
const verticalId = ref("");
const channelId = ref("");
const youtubeChannelRef = ref("");
const youtubeDisplayName = ref("");
const tiktokOpenId = ref("");
const tiktokDisplayName = ref("");
const tiktokCreator = ref<TikTokCreatorInfo | null>(null);
const tiktokPrivacy = ref("");
const tiktokDisableComment = ref(false);
const tiktokDisableDuet = ref(false);
const tiktokDisableStitch = ref(false);
const tiktokBrandContent = ref(false);
const tiktokBrandOrganic = ref(false);
const tiktokIsAigc = ref(false);
const tiktokConsent = ref(false);
const creatorLoading = ref(false);
const title = ref("");
const description = ref("");
const scheduledLocal = ref(defaultSchedule());
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const currentTime = ref(Date.now());
const minimumScheduledLocal = computed(() =>
  localDateTime(Math.ceil((currentTime.value + 60_000) / 60_000) * 60_000),
);
const scheduleIsValid = computed(() => {
  const instant = new Date(scheduledLocal.value).getTime();
  return Number.isFinite(instant) && instant >= currentTime.value + 30_000;
});
let publicationRefreshTimer: ReturnType<typeof setInterval> | undefined;

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
const activeChannels = computed(() =>
  channels.value.filter((item) => item.state === "ENABLED"),
);
const activeChannel = computed(() =>
  activeChannels.value.find((item) => item.id === channelId.value),
);
const contentKindOptions = computed(() =>
  activeChannel.value?.platform === "LOCAL_DRY_RUN"
    ? [
        { label: "Горизонтальный пакет", value: "EDITORIAL_EXPORT" },
        { label: "Вертикальный ролик", value: "VERTICAL_RESULT" },
      ]
    : [{ label: "Вертикальный ролик", value: "VERTICAL_RESULT" }],
);
const channelOptions = computed(() =>
  activeChannels.value.map((item) => ({
    id: item.id,
    label: `${item.platform === "YOUTUBE" ? "YouTube" : item.platform === "TIKTOK" ? "TikTok" : "Dry run"} · ${item.displayName}`,
  })),
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
    if (!nextChannels.some((item) => item.id === channelId.value))
      channelId.value =
        nextChannels.find((item) => item.platform === "YOUTUBE")?.id ??
        nextChannels.find((item) => item.platform === "TIKTOK")?.id ??
        nextChannels.find((item) => item.platform === "LOCAL_DRY_RUN")?.id ??
        "";
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
async function refreshPublicationStatuses(): Promise<void> {
  currentTime.value = Date.now();
  const selectedProjectId = projectId.value;
  if (
    !selectedProjectId ||
    loading.value ||
    saving.value ||
    refreshingPublications.value ||
    document.hidden
  )
    return;
  refreshingPublications.value = true;
  try {
    const page = await publicationsApi.list(selectedProjectId);
    if (projectId.value === selectedProjectId) publications.value = page.items;
  } catch {
    // Background refresh stays silent; foreground actions surface errors.
  } finally {
    refreshingPublications.value = false;
  }
}
async function createTikTokChannel(): Promise<void> {
  const externalChannelRef = tiktokOpenId.value.trim();
  if (
    !projectId.value ||
    saving.value ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(externalChannelRef)
  )
    return;
  saving.value = true;
  error.value = null;
  try {
    const created = await publicationsApi.createChannel(projectId.value, {
      platform: "TIKTOK",
      displayName: tiktokDisplayName.value.trim() || "TikTok",
      externalChannelRef,
      timezone,
    });
    channelId.value = created.id;
    tiktokOpenId.value = "";
    tiktokDisplayName.value = "";
    notice.value = "TikTok-аккаунт подключён. Проверьте настройки автора.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось подключить TikTok.";
  } finally {
    saving.value = false;
  }
}
async function loadTikTokCreator(): Promise<void> {
  tiktokCreator.value = null;
  tiktokConsent.value = false;
  if (!projectId.value || activeChannel.value?.platform !== "TIKTOK") return;
  creatorLoading.value = true;
  error.value = null;
  try {
    const info = await publicationsApi.getTikTokCreatorInfo(
      projectId.value,
      activeChannel.value.id,
    );
    tiktokCreator.value = info;
    tiktokPrivacy.value = info.privacyLevelOptions[0] ?? "";
    tiktokDisableComment.value = info.commentDisabled;
    tiktokDisableDuet.value = info.duetDisabled;
    tiktokDisableStitch.value = info.stitchDisabled;
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось получить настройки TikTok.";
  } finally {
    creatorLoading.value = false;
  }
}
async function createYoutubeChannel(): Promise<void> {
  const externalChannelRef = youtubeChannelRef.value.trim();
  if (
    !projectId.value ||
    saving.value ||
    !/^UC[A-Za-z0-9_-]{20,40}$/.test(externalChannelRef)
  )
    return;
  saving.value = true;
  error.value = null;
  try {
    const created = await publicationsApi.createChannel(projectId.value, {
      platform: "YOUTUBE",
      displayName: youtubeDisplayName.value.trim() || "YouTube",
      externalChannelRef,
      timezone,
    });
    channelId.value = created.id;
    youtubeChannelRef.value = "";
    youtubeDisplayName.value = "";
    notice.value = "YouTube-канал подключён и выбран.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось подключить YouTube-канал.";
  } finally {
    saving.value = false;
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
  currentTime.value = Date.now();
  if (!scheduleIsValid.value) {
    error.value = "Выберите время публикации хотя бы на минуту позже текущего.";
    return;
  }
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
    (activeChannel.value.platform === "TIKTOK" &&
      (!tiktokCreator.value || !tiktokPrivacy.value || !tiktokConsent.value)) ||
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
    const metadataSnapshot =
      activeChannel.value.platform === "TIKTOK"
        ? {
            title: title.value.trim() || projectName(projectId.value),
            privacyLevel: tiktokPrivacy.value,
            disableComment: tiktokDisableComment.value,
            disableDuet: tiktokDisableDuet.value,
            disableStitch: tiktokDisableStitch.value,
            brandContentToggle: tiktokBrandContent.value,
            brandOrganicToggle: tiktokBrandOrganic.value,
            isAigc: tiktokIsAigc.value,
            consent: {
              version: "tiktok-direct-post-consent-v1",
              creatorUsername: tiktokCreator.value!.creatorUsername,
              creatorInfoFetchedAt: tiktokCreator.value!.fetchedAt,
              confirmedAt: new Date().toISOString(),
            },
          }
        : {
            title: title.value.trim() || projectName(projectId.value),
            description: description.value.trim(),
            source: "content-factory-ui-v1",
          };
    await publicationsApi.create(
      projectId.value,
      {
        platform: activeChannel.value.platform,
        channelId: activeChannel.value.id,
        ...lineage,
        scheduledAt: new Date(scheduledLocal.value).toISOString(),
        timezone,
        metadataSnapshot,
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
async function retry(item: PublicationIntent): Promise<void> {
  if (saving.value || item.state !== "FAILED_FINAL") return;
  if (
    item.platform !== "LOCAL_DRY_RUN" &&
    !confirm(
      `Повторно отправить «${metadataTitle(item)}» в ${item.platform === "YOUTUBE" ? "YouTube" : "TikTok"}? Убедитесь, что публикации нет на площадке.`,
    )
  )
    return;
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await publicationsApi.retry(item.id);
    notice.value = "Публикация снова поставлена в очередь.";
    await loadWorkspace();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось повторить публикацию.";
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
function formatMetric(value: string): string {
  return BigInt(value).toLocaleString("ru-RU");
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
  return localDateTime(date.getTime());
}
function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

watch(projectId, () => {
  if (initialized.value) void loadWorkspace();
});
watch(channelId, () => void loadTikTokCreator());
watch(activeChannel, (channel) => {
  if (channel && channel.platform !== "LOCAL_DRY_RUN")
    contentKind.value = "VERTICAL_RESULT";
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
  publicationRefreshTimer = setInterval(
    () => void refreshPublicationStatuses(),
    15_000,
  );
});
onUnmounted(() => {
  if (publicationRefreshTimer) clearInterval(publicationRefreshTimer);
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
              <dl v-if="item.latestMetrics" class="publication-metrics">
                <div>
                  <dt>Просмотры</dt>
                  <dd>{{ formatMetric(item.latestMetrics.viewCount) }}</dd>
                </div>
                <div v-if="item.latestMetrics.likeCount !== null">
                  <dt>Лайки</dt>
                  <dd>{{ formatMetric(item.latestMetrics.likeCount) }}</dd>
                </div>
                <div v-if="item.latestMetrics.commentCount !== null">
                  <dt>Комментарии</dt>
                  <dd>{{ formatMetric(item.latestMetrics.commentCount) }}</dd>
                </div>
                <div v-if="item.latestMetrics.shareCount !== null">
                  <dt>Репосты</dt>
                  <dd>{{ formatMetric(item.latestMetrics.shareCount) }}</dd>
                </div>
              </dl>
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
              <small
                v-else-if="
                  item.state === 'FAILED_FINAL' && item.remotePublicationId
                "
                class="reconciliation-note"
              >
                Повтор заблокирован: площадка уже вернула Remote ID
                {{ item.remotePublicationId }}. Сначала проверьте публикацию на
                площадке.
              </small>
            </div>
            <Button
              v-if="['SCHEDULED', 'QUEUED'].includes(item.state)"
              severity="secondary"
              :disabled="saving"
              @click="cancel(item)"
              >Отменить</Button
            >
            <Button
              v-else-if="
                item.state === 'FAILED_FINAL' && !item.remotePublicationId
              "
              severity="secondary"
              :disabled="saving"
              @click="retry(item)"
              >Повторить</Button
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
          <span class="safe-badge">{{
            activeChannel?.platform === "YOUTUBE"
              ? "YouTube"
              : activeChannel?.platform === "TIKTOK"
                ? "TikTok"
                : "Dry run"
          }}</span>
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
            <details class="channel-connector">
              <summary>Подключить YouTube</summary>
              <p>
                Доступно, когда OAuth-канал разрешён администратором сервера.
              </p>
              <InputText
                v-model="youtubeChannelRef"
                placeholder="ID канала: UC…"
              />
              <InputText
                v-model="youtubeDisplayName"
                placeholder="Название канала"
                maxlength="120"
              />
              <Button
                type="button"
                severity="secondary"
                :disabled="
                  !/^UC[A-Za-z0-9_-]{20,40}$/.test(youtubeChannelRef.trim())
                "
                :loading="saving"
                @click="createYoutubeChannel"
                >Подключить YouTube</Button
              >
            </details>
            <details class="channel-connector">
              <summary>Подключить TikTok</summary>
              <p>Укажите immutable open_id из OAuth-настройки сервера.</p>
              <InputText v-model="tiktokOpenId" placeholder="TikTok open_id" />
              <InputText
                v-model="tiktokDisplayName"
                placeholder="Название аккаунта"
                maxlength="120"
              />
              <Button
                type="button"
                severity="secondary"
                :disabled="!/^[A-Za-z0-9._-]{1,128}$/.test(tiktokOpenId.trim())"
                :loading="saving"
                @click="createTikTokChannel"
                >Подключить TikTok</Button
              >
            </details>
          </div>
        </template>
        <form v-else class="schedule-form" @submit.prevent="schedule">
          <label
            ><span>Канал публикации</span
            ><Select
              v-model="channelId"
              :options="channelOptions"
              option-label="label"
              option-value="id"
          /></label>
          <label
            ><span>Формат контента</span
            ><Select
              v-model="contentKind"
              :options="contentKindOptions"
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
          <section
            v-if="activeChannel.platform === 'TIKTOK'"
            class="tiktok-consent"
            aria-labelledby="tiktok-settings-title"
          >
            <div class="title-row">
              <strong id="tiktok-settings-title">Настройки TikTok</strong>
              <Button
                type="button"
                severity="secondary"
                :loading="creatorLoading"
                @click="loadTikTokCreator"
                >Обновить</Button
              >
            </div>
            <p v-if="creatorLoading" class="hint">
              Проверяем настройки автора…
            </p>
            <template v-else-if="tiktokCreator">
              <p class="creator-identity">
                Публикация от
                <strong>@{{ tiktokCreator.creatorUsername }}</strong> · максимум
                {{ tiktokCreator.maxVideoPostDurationSec }} сек.
              </p>
              <label>
                <span>Видимость</span>
                <Select
                  v-model="tiktokPrivacy"
                  :options="tiktokCreator.privacyLevelOptions"
                />
              </label>
              <label class="check-row">
                <Checkbox
                  v-model="tiktokDisableComment"
                  binary
                  :disabled="tiktokCreator.commentDisabled"
                />
                <span>Отключить комментарии</span>
              </label>
              <label class="check-row">
                <Checkbox
                  v-model="tiktokDisableDuet"
                  binary
                  :disabled="tiktokCreator.duetDisabled"
                />
                <span>Отключить Duet</span>
              </label>
              <label class="check-row">
                <Checkbox
                  v-model="tiktokDisableStitch"
                  binary
                  :disabled="tiktokCreator.stitchDisabled"
                />
                <span>Отключить Stitch</span>
              </label>
              <label class="check-row">
                <Checkbox v-model="tiktokBrandContent" binary />
                <span>Брендированный контент</span>
              </label>
              <label class="check-row">
                <Checkbox v-model="tiktokBrandOrganic" binary />
                <span>Продвижение собственного бренда</span>
              </label>
              <label class="check-row">
                <Checkbox v-model="tiktokIsAigc" binary />
                <span>Контент создан или существенно изменён ИИ</span>
              </label>
              <label class="check-row consent-row">
                <Checkbox v-model="tiktokConsent" binary />
                <span
                  >Я проверил аккаунт, видимость и настройки и подтверждаю
                  прямую публикацию.</span
                >
              </label>
            </template>
            <p v-else class="hint">
              Свежие настройки автора недоступны. Публикация заблокирована.
            </p>
          </section>
          <label
            ><span>Дата и время</span
            ><input
              v-model="scheduledLocal"
              class="native-control"
              type="datetime-local"
              :min="minimumScheduledLocal"
              required
          /></label>
          <p class="timezone">
            Часовой пояс: <strong>{{ timezone }}</strong
            >. Прошедшее время выбрать нельзя.
          </p>
          <Button
            type="submit"
            :disabled="
              (contentKind === 'EDITORIAL_EXPORT' ? !exportId : !verticalId) ||
              !scheduleIsValid ||
              (activeChannel.platform === 'TIKTOK' &&
                (!tiktokCreator || !tiktokConsent || !tiktokPrivacy)) ||
              saving
            "
            :loading="saving"
            >Добавить в расписание</Button
          >
          <details class="channel-connector">
            <summary>Добавить YouTube-канал</summary>
            <p>Введите официальный ID канала, начинающийся с UC.</p>
            <InputText
              v-model="youtubeChannelRef"
              placeholder="ID канала: UC…"
            />
            <InputText
              v-model="youtubeDisplayName"
              placeholder="Название канала"
              maxlength="120"
            />
            <Button
              type="button"
              severity="secondary"
              :disabled="
                !/^UC[A-Za-z0-9_-]{20,40}$/.test(youtubeChannelRef.trim())
              "
              :loading="saving"
              @click="createYoutubeChannel"
              >Подключить</Button
            >
          </details>
          <details class="channel-connector">
            <summary>Добавить TikTok-аккаунт</summary>
            <p>
              Используется open_id, связанный с OAuth credential на сервере.
            </p>
            <InputText v-model="tiktokOpenId" placeholder="TikTok open_id" />
            <InputText
              v-model="tiktokDisplayName"
              placeholder="Название аккаунта"
              maxlength="120"
            />
            <Button
              type="button"
              severity="secondary"
              :disabled="!/^[A-Za-z0-9._-]{1,128}$/.test(tiktokOpenId.trim())"
              :loading="saving"
              @click="createTikTokChannel"
              >Подключить</Button
            >
          </details>
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
.tiktok-consent {
  display: grid;
  gap: 0.8rem;
  padding: 1rem;
  border: 1px solid color-mix(in srgb, var(--cf-brand) 28%, var(--cf-border));
  border-radius: var(--cf-radius-md);
  background: color-mix(in srgb, var(--cf-brand) 4%, var(--cf-surface));
}
.creator-identity {
  margin: 0;
  color: var(--cf-text-muted);
  font-size: 0.84rem;
}
.check-row {
  display: flex !important;
  align-items: flex-start;
  gap: 0.65rem !important;
  cursor: pointer;
}
.check-row > span {
  color: var(--cf-text) !important;
  font-size: 0.82rem !important;
  line-height: 1.35;
}
.consent-row {
  padding-top: 0.8rem;
  border-top: 1px solid var(--cf-border);
  font-weight: 700;
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
.publication-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 1rem;
  margin: 0.65rem 0 0;
}
.publication-metrics div {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
}
.publication-metrics dt {
  color: var(--cf-text-muted);
  font-size: 0.72rem;
}
.publication-metrics dd {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
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
.channel-connector {
  display: grid;
  gap: 0.65rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--cf-border);
}
.channel-connector summary {
  cursor: pointer;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
  font-weight: 750;
}
.channel-connector p {
  margin: 0;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
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
