<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, nextTick, ref } from "vue";
import { z } from "zod";

import PipelineJobCard from "~/entities/pipeline-job/ui/pipeline-job-card.vue";
import { useCutProject } from "~/entities/project/model/use-cut-project";
import {
  emptySegment,
  formatTimecode,
  parseTimecode,
  segmentFromBounds,
  validateSegments,
  type SegmentDraft,
} from "~/features/edit-cut-segments/model/segments";
import { useSubmitVideoCuts } from "~/features/submit-video-cuts/model/use-submit-video-cuts";
import {
  createMediaPipelineApi,
  MediaPipelineApiError,
} from "~/shared/api/media-pipeline";

const route = useRoute();
const projectIdSchema = z.uuid();
const projectId = computed(() => {
  const value = Array.isArray(route.query.projectId)
    ? route.query.projectId[0]
    : route.query.projectId;
  const parsed = projectIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
});
const enteredProjectId = ref(projectId.value ?? "");
const projectQuery = useCutProject(projectId);
const submitMutation = useSubmitVideoCuts();
const config = useRuntimeConfig();
const mediaApi = createMediaPipelineApi(config.public.apiBasePath);
const player = ref<HTMLVideoElement>();
const currentMs = ref(0);
const drafts = ref<SegmentDraft[]>([emptySegment()]);
const activeIndex = ref(0);
const submitted = ref(false);
const announcement = ref("");
const submitUnknown = ref(false);
let retryIdentity: { fingerprint: string; key: string } | undefined;

const durationMs = computed(() => projectQuery.data.value?.source.durationMs);
const authorizationCleared = computed(
  () => projectQuery.data.value?.source.authorization.status === "CLEARED",
);
const validation = computed(() =>
  durationMs.value === undefined
    ? { segments: [], errors: {} as Record<string, string> }
    : validateSegments(drafts.value, durationMs.value),
);
const canSubmit = computed(
  () =>
    Boolean(projectId.value) &&
    authorizationCleared.value &&
    durationMs.value !== undefined &&
    validation.value.segments.length === drafts.value.length &&
    drafts.value.length > 0 &&
    !submitMutation.isPending.value,
);
const jobIds = computed(() => {
  const raw = Array.isArray(route.query.jobs)
    ? route.query.jobs[0]
    : route.query.jobs;
  if (!raw) return [];
  return raw
    .split(",")
    .filter((id) => z.uuid().safeParse(id).success)
    .slice(0, 20);
});

function openProject(): void {
  if (!projectIdSchema.safeParse(enteredProjectId.value).success) return;
  void navigateTo({
    path: "/cuts",
    query: { projectId: enteredProjectId.value },
  });
}

function addSegment(): void {
  drafts.value.push(emptySegment());
  activeIndex.value = drafts.value.length - 1;
  void nextTick(() =>
    document.getElementById(`segment-${activeIndex.value}-start`)?.focus(),
  );
}

function cloneFailedSegment(bounds: { startMs: number; endMs: number }): void {
  const cloned = segmentFromBounds(bounds.startMs, bounds.endMs);
  if (
    drafts.value.length === 1 &&
    !drafts.value[0]?.startText &&
    !drafts.value[0]?.endText
  ) {
    drafts.value = [cloned];
    activeIndex.value = 0;
  } else {
    drafts.value.push(cloned);
    activeIndex.value = drafts.value.length - 1;
  }
  submitted.value = false;
  announcement.value = `Создан новый отрезок ${formatTimecode(bounds.startMs)}–${formatTimecode(bounds.endMs)}.`;
  void nextTick(() =>
    document.getElementById(`segment-${activeIndex.value}-start`)?.focus(),
  );
}

function removeSegment(index: number): void {
  const draft = drafts.value[index];
  if (!draft) return;
  if (
    (draft.startText || draft.endText) &&
    !confirm("Удалить заполненный отрезок?")
  )
    return;
  drafts.value.splice(index, 1);
  if (drafts.value.length === 0) drafts.value.push(emptySegment());
  activeIndex.value = Math.max(
    0,
    Math.min(activeIndex.value, drafts.value.length - 1),
  );
}

function normalizeField(
  draft: SegmentDraft,
  field: "startText" | "endText",
): void {
  const parsed = parseTimecode(draft[field]);
  if (parsed !== null) draft[field] = formatTimecode(parsed);
}

function setMarker(field: "startText" | "endText"): void {
  const draft = drafts.value[activeIndex.value] ?? drafts.value[0];
  if (!draft) return;
  const value = Math.round((player.value?.currentTime ?? 0) * 1_000);
  draft[field] = formatTimecode(value);
  const label = field === "startText" ? "Начало" : "Конец";
  announcement.value = `${label} отрезка ${activeIndex.value + 1} установлено: ${formatTimecode(value)}`;
}

function onTimeUpdate(): void {
  currentMs.value = Math.round((player.value?.currentTime ?? 0) * 1_000);
}

async function submit(): Promise<void> {
  submitted.value = true;
  submitUnknown.value = false;
  if (!canSubmit.value || !projectId.value) return;
  const fingerprint = JSON.stringify(validation.value.segments);
  const idempotencyKey =
    retryIdentity?.fingerprint === fingerprint
      ? retryIdentity.key
      : `cuts-${crypto.randomUUID()}`;
  retryIdentity = { fingerprint, key: idempotencyKey };
  try {
    const result = await submitMutation.mutateAsync({
      projectId: projectId.value,
      idempotencyKey,
      segments: validation.value.segments,
    });
    retryIdentity = undefined;
    drafts.value = [emptySegment()];
    submitted.value = false;
    await navigateTo({
      path: "/cuts",
      query: {
        projectId: projectId.value,
        jobs: result.jobs.map((job) => job.id).join(","),
      },
    });
  } catch (error) {
    submitUnknown.value =
      error instanceof MediaPipelineApiError && error.code === "NETWORK_ERROR";
  }
}
</script>

<template>
  <section class="workspace" aria-labelledby="cutting-title">
    <header class="workspace-header">
      <div>
        <p class="eyebrow">Content Factory · Этап 1</p>
        <h1 id="cutting-title">Нарезка видео</h1>
      </div>
      <NuxtLink to="/">Загрузить другое видео</NuxtLink>
    </header>

    <form
      v-if="!projectId"
      class="source-selector"
      @submit.prevent="openProject"
    >
      <p>Выберите загруженное видео, чтобы начать нарезку.</p>
      <label for="project-id">UUID проекта</label>
      <InputText
        id="project-id"
        v-model="enteredProjectId"
        class="text-input"
      />
      <Button
        type="submit"
        :disabled="!projectIdSchema.safeParse(enteredProjectId).success"
        >Открыть видео</Button
      >
    </form>

    <p v-else-if="projectQuery.isLoading.value">
      Загружаем сведения об исходном видео…
    </p>
    <div v-else-if="projectQuery.isError.value" class="error" role="alert">
      <p>
        Не удалось открыть исходное видео. Оно могло быть перемещено или ещё не
        сохранено.
      </p>
      <Button type="button" @click="projectQuery.refetch()"
        >Обновить сейчас</Button
      >
    </div>
    <template v-else-if="projectQuery.data.value">
      <p class="source-meta">
        <strong>{{ projectQuery.data.value.name }}</strong> ·
        {{ projectQuery.data.value.source.originalFilename }} ·
        {{ projectQuery.data.value.source.sizeBytes }} байт · Длительность:
        {{
          durationMs === undefined ? "проверяется" : formatTimecode(durationMs)
        }}
      </p>

      <div
        v-if="projectQuery.data.value.status !== 'SOURCE_READY'"
        class="warning"
      >
        <p>Исходное видео ещё не готово к нарезке.</p>
        <Button type="button" @click="projectQuery.refetch()"
          >Обновить сейчас</Button
        >
      </div>
      <div v-else-if="!authorizationCleared" class="warning">
        <p>
          Для этой версии исходника не подтверждены права. Просмотр и нарезка
          заблокированы.
        </p>
        <NuxtLink to="/library">Подтвердить права в медиатеке</NuxtLink>
      </div>
      <div v-else-if="durationMs === undefined" class="warning" role="status">
        <p v-if="projectQuery.data.value.source.probeState !== 'FAILED_FINAL'">
          Проверяем длительность видео. Поля времени станут доступны после
          проверки.
        </p>
        <p v-else class="error">
          {{
            projectQuery.data.value.source.probeFailure?.message ??
            "Не удалось проверить исходный MP4."
          }}
        </p>
        <progress aria-label="Проверка длительности видео" />
      </div>

      <div
        v-if="authorizationCleared"
        class="editor-grid"
        :class="{ disabled: durationMs === undefined }"
      >
        <section class="player-panel" aria-labelledby="player-title">
          <h2 id="player-title">Исходное видео</h2>
          <video
            ref="player"
            controls
            preload="metadata"
            :src="mediaApi.sourceUrl(projectQuery.data.value.id)"
            :aria-label="`Просмотр исходного видео: ${projectQuery.data.value.source.originalFilename}`"
            @timeupdate="onTimeUpdate"
          />
          <p>
            Текущая позиция: <strong>{{ formatTimecode(currentMs) }}</strong>
          </p>
          <div class="marker-actions">
            <Button
              type="button"
              :disabled="durationMs === undefined"
              @click="setMarker('startText')"
              >Установить начало</Button
            >
            <Button
              type="button"
              :disabled="durationMs === undefined"
              @click="setMarker('endText')"
              >Установить конец</Button
            >
          </div>
          <p class="sr-only" aria-live="polite">{{ announcement }}</p>
        </section>

        <form class="segments-panel" @submit.prevent="submit">
          <h2>Отрезки</h2>
          <p>
            Каждый отрезок станет отдельным MP4 для самостоятельной загрузки на
            YouTube.
          </p>
          <article
            v-for="(draft, index) in drafts"
            :key="draft.clientKey"
            class="segment-row"
          >
            <h3>Отрезок {{ index + 1 }}</h3>
            <label :for="`segment-${index}-start`">Начало</label>
            <input
              :id="`segment-${index}-start`"
              v-model="draft.startText"
              class="text-input"
              placeholder="00:00:00.000"
              :disabled="
                durationMs === undefined || submitMutation.isPending.value
              "
              :aria-invalid="
                submitted && Boolean(validation.errors[draft.clientKey])
              "
              :aria-describedby="`segment-${index}-error`"
              @focus="activeIndex = index"
              @blur="normalizeField(draft, 'startText')"
              @keydown.enter.prevent="normalizeField(draft, 'startText')"
            />
            <label :for="`segment-${index}-end`">Конец</label>
            <input
              :id="`segment-${index}-end`"
              v-model="draft.endText"
              class="text-input"
              placeholder="00:00:10.000"
              :disabled="
                durationMs === undefined || submitMutation.isPending.value
              "
              :aria-invalid="
                submitted && Boolean(validation.errors[draft.clientKey])
              "
              :aria-describedby="`segment-${index}-error`"
              @focus="activeIndex = index"
              @blur="normalizeField(draft, 'endText')"
              @keydown.enter.prevent="normalizeField(draft, 'endText')"
            />
            <p
              v-if="submitted && validation.errors[draft.clientKey]"
              :id="`segment-${index}-error`"
              class="error"
            >
              {{ validation.errors[draft.clientKey] }}
            </p>
            <Button
              type="button"
              severity="secondary"
              @click="removeSegment(index)"
              >Удалить</Button
            >
          </article>
          <Button
            type="button"
            severity="secondary"
            :disabled="drafts.length >= 20"
            @click="addSegment"
            >Добавить отрезок</Button
          >
          <p id="submit-help">
            Будет создано {{ validation.segments.length }} независимых заданий.
            Обработка идёт в фоне.
          </p>
          <Button
            type="submit"
            :disabled="!canSubmit"
            aria-describedby="submit-help"
          >
            {{
              submitMutation.isPending.value
                ? "Создаём задания…"
                : `Запустить нарезку (${validation.segments.length})`
            }}
          </Button>
          <p v-if="submitUnknown" class="warning" role="status">
            Мы не знаем, получил ли сервер запрос. Повторите с теми же границами
            — дубликаты не будут созданы.
          </p>
          <p
            v-else-if="submitMutation.isError.value"
            class="error"
            role="alert"
          >
            {{
              (submitMutation.error.value as Error)?.message ??
              "Не удалось создать задания."
            }}
          </p>
        </form>
      </div>

      <section v-if="jobIds.length" class="jobs" aria-labelledby="jobs-title">
        <h2 id="jobs-title">Задания обработки</h2>
        <PipelineJobCard
          v-for="jobIdValue in jobIds"
          :key="jobIdValue"
          :job-id="jobIdValue"
          @clone-segment="cloneFailedSegment"
        />
      </section>
    </template>
  </section>
</template>

<style scoped>
.workspace {
  box-sizing: border-box;
  max-width: 88rem;
  min-height: 100vh;
  margin: 0 auto;
  padding: 2rem clamp(1rem, 3vw, 3rem) 5rem;
}
.workspace-header,
.job-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.eyebrow {
  margin: 0;
  color: #65736b;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
h1 {
  margin: 0.25rem 0 0;
  font-size: clamp(2rem, 5vw, 4rem);
}
.source-meta,
.source-selector,
.warning,
.error {
  padding: 1rem;
  border-radius: 0.75rem;
}
.source-meta,
.source-selector {
  background: #fff;
  border: 1px solid #d9e0d8;
}
.warning {
  background: #fff7d6;
}
.error {
  color: #991b1b;
  background: #fff1f1;
}
.editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(18rem, 1fr);
  gap: 1.5rem;
  margin-top: 1.5rem;
  align-items: start;
}
.player-panel,
.segments-panel {
  padding: 1rem;
  border: 1px solid #d9e0d8;
  border-radius: 1rem;
  background: #fff;
}
video {
  display: block;
  width: 100%;
  max-height: 70vh;
  background: #111;
  border-radius: 0.75rem;
}
.marker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.segment-row {
  display: grid;
  gap: 0.45rem;
  padding: 1rem 0;
  border-top: 1px solid #d9e0d8;
}
.segment-row h3 {
  margin: 0;
}
.text-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 0.65rem;
  border: 1px solid #829188;
  border-radius: 0.5rem;
  font: inherit;
}
.jobs {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 1023px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}
</style>
