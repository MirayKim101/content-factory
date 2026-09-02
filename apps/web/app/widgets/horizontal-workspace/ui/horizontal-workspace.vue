<script setup lang="ts">
import { useQueries } from "@tanstack/vue-query";
import Button from "primevue/button";
import { computed, nextTick, ref, watch } from "vue";

import PipelineJobCard from "~/entities/pipeline-job/ui/pipeline-job-card.vue";
import {
  emptySegment,
  formatTimecode,
  parseTimecode,
  validateSegments,
  type SegmentDraft,
} from "~/features/edit-cut-segments/model/segments";
import {
  cutRequestFingerprint,
  firstReadyProjectId,
  getSessionSourceState,
  idempotencyForCutRequest,
  markerTimecode,
  type WorkspaceSourceState,
} from "~/features/edit-cut-segments/model/workspace-state";
import { normalizeProjectIds } from "~/features/select-library-sources/model/selection";
import {
  createMediaPipelineApi,
  MediaPipelineApiError,
} from "~/shared/api/media-pipeline";
import { createProjectsApi } from "~/shared/api/projects";

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const mediaApi = createMediaPipelineApi(config.public.apiBasePath);
const normalized = computed(() => normalizeProjectIds(route.query.projectIds));
const ids = computed(() => normalized.value.ids);
const activeProjectId = ref<string>();
const player = ref<HTMLVideoElement>();
const currentMs = ref(0);
const announcement = ref("");
const projectQueries = useQueries({
  queries: computed(() =>
    ids.value.map((id) => ({
      queryKey: ["project", id],
      queryFn: () => projectsApi.getProject!(id),
      retry: 1,
    })),
  ),
});
const rows = computed(() =>
  ids.value.flatMap((id, index) => {
    const query = projectQueries.value[index];
    return query ? [{ id, query }] : [];
  }),
);
const activeRow = computed(() =>
  rows.value.find((row) => row.id === activeProjectId.value),
);
const activeProject = computed(() => activeRow.value?.query.data);

function ensureState(id: string): WorkspaceSourceState {
  return getSessionSourceState(id);
}
function removeSource(id: string): void {
  const next = ids.value.filter((item) => item !== id);
  activeProjectId.value = next[0];
  void navigateTo({
    path: "/horizontal",
    query: next.length ? { projectIds: next.join(",") } : {},
  });
}
function openPlayer(id: string): void {
  activeProjectId.value = id;
  currentMs.value = 0;
  announcement.value = "Видео открыто в плеере.";
}
function addSegment(id: string): void {
  const state = ensureState(id);
  state.drafts.push(emptySegment());
  state.activeSegment = state.drafts.length - 1;
  openPlayer(id);
  void nextTick(() =>
    document
      .getElementById(`horizontal-${id}-${state.activeSegment}-start`)
      ?.focus(),
  );
}
function removeSegment(id: string, index: number): void {
  const state = ensureState(id);
  state.drafts.splice(index, 1);
  if (!state.drafts.length) state.drafts.push(emptySegment());
  state.activeSegment = Math.min(state.activeSegment, state.drafts.length - 1);
}
function normalizeField(
  draft: SegmentDraft,
  field: "startText" | "endText",
): void {
  const parsed = parseTimecode(draft[field]);
  if (parsed !== null) draft[field] = formatTimecode(parsed);
}
function draftError(
  id: string,
  draft: SegmentDraft,
  durationMs: number | undefined,
): string | undefined {
  if (!ensureState(id).submitted || durationMs === undefined) return undefined;
  return validateSegments(ensureState(id).drafts, durationMs).errors[
    draft.clientKey
  ];
}
function setMarker(field: "startText" | "endText"): void {
  const id = activeProjectId.value;
  if (!id) return;
  const state = ensureState(id);
  const draft = state.drafts[state.activeSegment];
  if (!draft) return;
  draft[field] = markerTimecode(player.value?.currentTime ?? 0);
  announcement.value = `${field === "startText" ? "Начало" : "Конец"} установлено для активного видео.`;
}
async function submit(
  id: string,
  durationMs: number | undefined,
): Promise<void> {
  const state = ensureState(id);
  state.submitted = true;
  state.error = undefined;
  if (durationMs === undefined || state.submitting) return;
  const validated = validateSegments(state.drafts, durationMs);
  if (validated.segments.length !== state.drafts.length) return;
  const fingerprint = cutRequestFingerprint(validated.segments);
  const identity = idempotencyForCutRequest(
    state.retryIdentity,
    fingerprint,
    () => `horizontal-cuts-${crypto.randomUUID()}`,
  );
  state.retryIdentity = identity;
  state.submitting = true;
  try {
    const result = await mediaApi.createCuts({
      projectId: id,
      idempotencyKey: identity.key,
      segments: validated.segments,
    });
    state.retryIdentity = undefined;
    state.jobs = result.jobs.map((job) => job.id);
    state.drafts = [emptySegment()];
    state.activeSegment = 0;
    state.submitted = false;
    announcement.value = "Задания нарезки созданы для выбранного видео.";
  } catch (error) {
    if (
      !(error instanceof MediaPipelineApiError) ||
      error.code !== "NETWORK_ERROR"
    ) {
      state.retryIdentity = undefined;
    }
    state.error =
      error instanceof MediaPipelineApiError && error.code === "NETWORK_ERROR"
        ? "Мы не знаем, получил ли сервер запрос. Повторите с теми же таймкодами — дубликаты не будут созданы."
        : error instanceof Error
          ? error.message
          : "Не удалось создать задания.";
  } finally {
    state.submitting = false;
  }
}
function cloneSegment(
  id: string,
  bounds: { startMs: number; endMs: number },
): void {
  const state = ensureState(id);
  state.drafts.push({
    clientKey: crypto.randomUUID(),
    startText: formatTimecode(bounds.startMs),
    endText: formatTimecode(bounds.endMs),
  });
  state.activeSegment = state.drafts.length - 1;
  openPlayer(id);
}
watch(
  ids,
  (next) => {
    for (const id of next) ensureState(id);
    if (!next.includes(activeProjectId.value ?? ""))
      activeProjectId.value = next[0];
  },
  { immediate: true },
);
watch(
  () =>
    rows.value.map((row) => ({ id: row.id, status: row.query.data?.status })),
  (loadedRows) => {
    const readyId = firstReadyProjectId(loadedRows, activeProjectId.value);
    if (readyId) activeProjectId.value = readyId;
  },
  { deep: true, immediate: true },
);
</script>

<template>
  <main class="workspace" aria-labelledby="horizontal-title">
    <header class="header">
      <div>
        <p class="eyebrow">Content Factory · Этап 1.5</p>
        <h1 id="horizontal-title">Горизонтальные видео</h1>
        <p>Выбрано: {{ ids.length }} источников</p>
      </div>
      <NuxtLink
        class="add"
        :to="{ path: '/library', query: { returnTo: route.fullPath } }"
        >Добавить видео</NuxtLink
      >
    </header>
    <p v-if="normalized.removed" class="warning" role="status">
      Некоторые ссылки на видео недействительны и не были открыты.
    </p>
    <section v-if="!ids.length" class="empty">
      <p>Здесь появятся выбранные исходники и их таймкоды.</p>
      <NuxtLink to="/library">Выбрать видео в медиатеке</NuxtLink>
    </section>
    <template v-else>
      <section
        v-if="activeProject"
        class="player-panel"
        aria-labelledby="active-player-title"
      >
        <h2 id="active-player-title">
          {{ activeProject.source.originalFilename }}
        </h2>
        <video
          ref="player"
          controls
          preload="metadata"
          :src="mediaApi.sourceUrl(activeProject.id)"
          :aria-label="`Просмотр исходного видео: ${activeProject.source.originalFilename}`"
          @timeupdate="
            currentMs = Math.round(
              ($event.target as HTMLVideoElement).currentTime * 1000,
            )
          "
        />
        <p>
          Позиция: <strong>{{ formatTimecode(currentMs) }}</strong>
        </p>
        <div class="actions">
          <Button type="button" @click="setMarker('startText')"
            >Установить начало</Button
          ><Button type="button" @click="setMarker('endText')"
            >Установить конец</Button
          >
        </div>
      </section>
      <p class="sr-only" aria-live="polite">{{ announcement }}</p>
      <section class="source-list" aria-label="Выбранные исходные видео">
        <article v-for="row in rows" :key="row.id" class="source-row">
          <p v-if="row.query.isLoading">Загружаем исходное видео…</p>
          <div v-else-if="row.query.isError" class="error">
            <h2>Видео недоступно</h2>
            <p>Не удалось открыть этот источник.</p>
            <Button type="button" @click="removeSource(row.id)"
              >Убрать из рабочего места</Button
            >
          </div>
          <template v-else-if="row.query.data">
            <header class="source-header">
              <div>
                <h2>{{ row.query.data.source.originalFilename }}</h2>
                <p>
                  {{ row.query.data.name }} ·
                  {{
                    row.query.data.source.durationMs === undefined
                      ? "длительность проверяется"
                      : formatTimecode(row.query.data.source.durationMs)
                  }}
                </p>
              </div>
              <div class="actions">
                <Button
                  type="button"
                  severity="secondary"
                  @click="openPlayer(row.id)"
                  >{{
                    activeProjectId === row.id ? "В плеере" : "Открыть в плеере"
                  }}</Button
                ><Button
                  type="button"
                  severity="secondary"
                  @click="removeSource(row.id)"
                  >Убрать</Button
                >
              </div>
            </header>
            <p v-if="row.query.data.status !== 'SOURCE_READY'" class="warning">
              Исходник пока недоступен для нарезки.
              <Button type="button" @click="row.query.refetch()"
                >Обновить сейчас</Button
              >
            </p>
            <form
              v-else
              @submit.prevent="submit(row.id, row.query.data.source.durationMs)"
            >
              <article
                v-for="(draft, index) in ensureState(row.id).drafts"
                :key="draft.clientKey"
                class="segment"
              >
                <h3>Отрезок {{ index + 1 }}</h3>
                <label :for="`horizontal-${row.id}-${index}-start`"
                  >Начало</label
                ><input
                  :id="`horizontal-${row.id}-${index}-start`"
                  v-model="draft.startText"
                  placeholder="00:00:00.000"
                  :aria-invalid="
                    Boolean(
                      draftError(
                        row.id,
                        draft,
                        row.query.data.source.durationMs,
                      ),
                    )
                  "
                  :aria-describedby="`horizontal-${row.id}-${index}-error`"
                  @focus="
                    ensureState(row.id).activeSegment = index;
                    openPlayer(row.id);
                  "
                  @blur="normalizeField(draft, 'startText')"
                />
                <label :for="`horizontal-${row.id}-${index}-end`">Конец</label
                ><input
                  :id="`horizontal-${row.id}-${index}-end`"
                  v-model="draft.endText"
                  placeholder="00:00:10.000"
                  :aria-invalid="
                    Boolean(
                      draftError(
                        row.id,
                        draft,
                        row.query.data.source.durationMs,
                      ),
                    )
                  "
                  :aria-describedby="`horizontal-${row.id}-${index}-error`"
                  @focus="
                    ensureState(row.id).activeSegment = index;
                    openPlayer(row.id);
                  "
                  @blur="normalizeField(draft, 'endText')"
                />
                <p
                  v-if="
                    draftError(row.id, draft, row.query.data.source.durationMs)
                  "
                  :id="`horizontal-${row.id}-${index}-error`"
                  class="error"
                >
                  {{
                    draftError(row.id, draft, row.query.data.source.durationMs)
                  }}
                </p>
                <Button
                  type="button"
                  severity="secondary"
                  @click="removeSegment(row.id, index)"
                  >Удалить</Button
                >
              </article>
              <div class="actions">
                <Button
                  type="button"
                  severity="secondary"
                  @click="addSegment(row.id)"
                  >Добавить отрезок</Button
                ><Button
                  type="submit"
                  :disabled="
                    row.query.data.source.durationMs === undefined ||
                    ensureState(row.id).submitting
                  "
                  >{{
                    ensureState(row.id).submitting
                      ? "Создаём задания…"
                      : `Запустить нарезку (${ensureState(row.id).drafts.length})`
                  }}</Button
                >
              </div>
              <p v-if="ensureState(row.id).error" class="error" role="alert">
                {{ ensureState(row.id).error }}
              </p>
            </form>
            <section
              v-if="ensureState(row.id).jobs.length"
              class="jobs"
              :aria-label="`Задания ${row.query.data.source.originalFilename}`"
            >
              <PipelineJobCard
                v-for="jobId in ensureState(row.id).jobs"
                :key="jobId"
                :job-id="jobId"
                @clone-segment="cloneSegment(row.id, $event)"
              />
            </section>
          </template>
        </article>
      </section>
    </template>
  </main>
</template>

<style scoped>
.workspace {
  box-sizing: border-box;
  max-width: 88rem;
  margin: 0 auto;
  padding: 2rem clamp(1rem, 3vw, 3rem) 5rem;
}
.header,
.source-header,
.actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
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
.add {
  padding: 0.7rem 1rem;
  border-radius: 0.5rem;
  background: #234d35;
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}
.player-panel {
  position: sticky;
  top: 1rem;
  z-index: 1;
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #d9e0d8;
  border-radius: 1rem;
  background: #fff;
}
.player-panel h2 {
  margin-top: 0;
}
video {
  display: block;
  width: 100%;
  max-height: 55vh;
  background: #111;
  border-radius: 0.75rem;
}
.source-list,
.jobs {
  display: grid;
  gap: 1rem;
}
.source-row {
  padding: 1rem;
  border: 1px solid #d9e0d8;
  border-radius: 0.8rem;
  background: #fff;
}
.source-header h2,
.source-header p {
  margin: 0.1rem 0;
}
.segment {
  display: grid;
  gap: 0.35rem;
  padding: 1rem 0;
  border-top: 1px solid #d9e0d8;
}
.segment h3 {
  margin: 0;
}
.segment input {
  min-height: 44px;
  padding: 0.55rem;
  border: 1px solid #829188;
  border-radius: 0.5rem;
  font: inherit;
}
.warning {
  padding: 0.75rem;
  background: #fff7d6;
}
.error {
  color: #991b1b;
}
.empty {
  padding: 2rem;
  border: 1px solid #d9e0d8;
  background: #fff;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
@media (max-width: 1023px) {
  .player-panel {
    position: static;
  }
}
@media (max-width: 560px) {
  .workspace {
    padding-top: 1rem;
  }
  .header,
  .source-header {
    align-items: flex-start;
  }
}
</style>
