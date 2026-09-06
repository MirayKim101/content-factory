<script setup lang="ts">
import { useQueries, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Card from "primevue/card";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import { computed, nextTick, ref, watch } from "vue";

import PipelineJobCard from "~/entities/pipeline-job/ui/pipeline-job-card.vue";
import AssemblyRecipeDialog from "~/features/edit-assembly-recipe/ui/assembly-recipe-dialog.vue";
import EditorialPackageDialog from "~/features/edit-editorial-package/ui/editorial-package-dialog.vue";
import {
  emptySegment,
  createCutSubmissionSummary,
  formatTimecode,
  parseTimecode,
  validateSegments,
  type SegmentDraft,
} from "~/features/edit-cut-segments/model/segments";
import {
  cutRequestFingerprint,
  getSessionSourceState,
  idempotencyForCutRequest,
  isCurrentWorkspaceSource,
  markerTimecode,
  reconcileWorkspaceSource,
  type WorkspaceSourceState,
} from "~/features/edit-cut-segments/model/workspace-state";
import { normalizeProjectIds } from "~/features/select-library-sources/model/selection";
import {
  createMediaPipelineApi,
  MediaPipelineApiError,
} from "~/shared/api/media-pipeline";
import { createProjectsApi } from "~/shared/api/projects";
import { formatDisplayTimecode } from "~/shared/lib/timecode";

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const mediaApi = createMediaPipelineApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const normalized = computed(() => normalizeProjectIds(route.query.projectIds));
const ids = computed(() => normalized.value.ids);
const editorProjectId = ref<string>();
const players = new Map<string, HTMLVideoElement>();
const editorPlayer = ref<HTMLVideoElement>();
const currentMsById = ref<Record<string, number>>({});
const announcement = ref("");
const editorialTarget = ref<{
  projectId: string;
  jobId: string;
  filename: string;
}>();
const assemblyTarget = ref<{
  projectId: string;
  jobId: string;
  filename: string;
  durationMs: number;
}>();
const projectQueries = useQueries({
  queries: computed(() =>
    ids.value.map((id) => ({
      queryKey: ["project", id],
      queryFn: () => projectsApi.getProject!(id),
      retry: 1,
    })),
  ),
});
const historyQueries = useQueries({
  queries: computed(() =>
    ids.value.map((id, index) => ({
      queryKey: [
        "project-cut-jobs",
        id,
        projectQueries.value[index]?.data?.source.id,
        projectQueries.value[index]?.data?.source.sourceVersion,
      ],
      queryFn: () => mediaApi.listProjectJobs(id),
      enabled:
        projectQueries.value[index]?.data?.source.authorization.usable === true,
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
const editorRow = computed(() =>
  rows.value.find((row) => row.id === editorProjectId.value),
);
const editorProject = computed(() => editorRow.value?.query.data);

function ensureState(id: string): WorkspaceSourceState {
  return getSessionSourceState(id);
}
function clearConfirmation(id: string): void {
  ensureState(id).confirmation = undefined;
}
function removeSource(id: string): void {
  const next = ids.value.filter((item) => item !== id);
  if (editorProjectId.value === id) editorProjectId.value = undefined;
  void navigateTo({
    path: "/horizontal",
    query: next.length ? { projectIds: next.join(",") } : {},
  });
}
function setPlayer(id: string, element: unknown): void {
  if (element instanceof HTMLVideoElement) players.set(id, element);
  else players.delete(id);
}
function updateCurrentTime(id: string, event: Event): void {
  currentMsById.value = {
    ...currentMsById.value,
    [id]: Math.round((event.target as HTMLVideoElement).currentTime * 1000),
  };
}
function keepSinglePlayer(event: Event): void {
  const active = event.currentTarget as HTMLVideoElement;
  for (const video of players.values()) {
    if (video !== active && !video.paused) video.pause();
  }
  if (editorPlayer.value !== active && !editorPlayer.value?.paused)
    editorPlayer.value?.pause();
}
function openEditor(id: string): void {
  for (const video of players.values()) {
    if (!video.paused) video.pause();
  }
  editorProjectId.value = id;
  announcement.value = "Открыты настройки нарезки выбранного видео.";
}
function addSegment(id: string): void {
  const state = ensureState(id);
  clearConfirmation(id);
  state.drafts.push(emptySegment());
  state.activeSegment = state.drafts.length - 1;
  openEditor(id);
  void nextTick(() =>
    document
      .getElementById(`horizontal-${id}-${state.activeSegment}-start`)
      ?.focus(),
  );
}
function removeSegment(id: string, index: number): void {
  const state = ensureState(id);
  clearConfirmation(id);
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
  const id = editorProjectId.value;
  if (!id) return;
  const state = ensureState(id);
  clearConfirmation(id);
  const draft = state.drafts[state.activeSegment];
  if (!draft) return;
  draft[field] = markerTimecode(
    editorPlayer.value?.currentTime ?? players.get(id)?.currentTime ?? 0,
  );
  announcement.value = `${field === "startText" ? "Начало" : "Конец"} установлено для активного видео.`;
}
function requestConfirmation(id: string, durationMs: number | undefined): void {
  const state = ensureState(id);
  state.submitted = true;
  state.error = undefined;
  state.confirmation = undefined;
  if (durationMs === undefined || state.submitting) return;
  const result = createCutSubmissionSummary(state.drafts, durationMs);
  if (!result.summary) return;
  state.confirmation = result.summary;
  announcement.value = `Проверьте ${result.summary.segments.length} нормализованных отрезка перед запуском.`;
}
async function submit(
  id: string,
  durationMs: number | undefined,
): Promise<void> {
  const state = ensureState(id);
  state.submitted = true;
  state.error = undefined;
  if (durationMs === undefined || state.submitting) return;
  const confirmation = state.confirmation;
  const current = createCutSubmissionSummary(state.drafts, durationMs);
  if (!confirmation || !current.summary) return;
  const fingerprint = cutRequestFingerprint(current.summary.segments);
  if (fingerprint !== cutRequestFingerprint(confirmation.segments)) {
    state.confirmation = undefined;
    announcement.value =
      "Таймкоды изменились. Проверьте нормализованные границы ещё раз.";
    return;
  }
  const identity = idempotencyForCutRequest(
    state.retryIdentity,
    fingerprint,
    () => `horizontal-cuts-${crypto.randomUUID()}`,
  );
  state.retryIdentity = identity;
  state.submitting = true;
  const sourceIdentity = state.sourceIdentity;
  try {
    const result = await mediaApi.createCuts({
      projectId: id,
      idempotencyKey: identity.key,
      segments: confirmation.segments,
    });
    if (!isCurrentWorkspaceSource(state, sourceIdentity)) return;
    state.retryIdentity = undefined;
    state.jobs = [
      ...result.jobs.map((job) => job.id),
      ...state.jobs.filter(
        (jobId) => !result.jobs.some((job) => job.id === jobId),
      ),
    ];
    for (const job of result.jobs) {
      queryClient.setQueryData(["pipeline-job", job.id], job);
    }
    void queryClient.invalidateQueries({
      queryKey: ["project-cut-jobs", id],
    });
    state.drafts = [emptySegment()];
    state.confirmation = undefined;
    state.activeSegment = 0;
    state.submitted = false;
    announcement.value = "Задания нарезки созданы для выбранного видео.";
  } catch (error) {
    if (!isCurrentWorkspaceSource(state, sourceIdentity)) return;
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
    if (isCurrentWorkspaceSource(state, sourceIdentity)) {
      state.submitting = false;
    }
  }
}
function cloneSegment(
  id: string,
  bounds: { startMs: number; endMs: number },
): void {
  const state = ensureState(id);
  clearConfirmation(id);
  state.drafts.push({
    clientKey: crypto.randomUUID(),
    startText: formatTimecode(bounds.startMs),
    endText: formatTimecode(bounds.endMs),
  });
  state.activeSegment = state.drafts.length - 1;
  openEditor(id);
}
function openEditorial(
  projectId: string,
  jobId: string,
  filename: string,
): void {
  editorialTarget.value = { projectId, jobId, filename };
  announcement.value = "Открыт редактор metadata готовой нарезки.";
}
function openAssembly(
  projectId: string,
  jobId: string,
  filename: string,
  durationMs: number,
): void {
  assemblyTarget.value = { projectId, jobId, filename, durationMs };
  announcement.value = "Открыт редактор монтажного рецепта готовой нарезки.";
}
watch(
  ids,
  (next) => {
    for (const id of next) ensureState(id);
    if (!next.includes(editorProjectId.value ?? ""))
      editorProjectId.value = undefined;
    if (!next.includes(editorialTarget.value?.projectId ?? ""))
      editorialTarget.value = undefined;
    if (!next.includes(assemblyTarget.value?.projectId ?? ""))
      assemblyTarget.value = undefined;
  },
  { immediate: true },
);
watch(
  () =>
    rows.value.map((row) => ({
      id: row.id,
      sourceId: row.query.data?.source.id,
      sourceVersion: row.query.data?.source.sourceVersion,
    })),
  (sources) => {
    for (const source of sources) {
      if (source.sourceId === undefined || source.sourceVersion === undefined)
        continue;
      const state = ensureState(source.id);
      const changed = reconcileWorkspaceSource(
        state,
        source.sourceId,
        source.sourceVersion,
      );
      if (changed) {
        players.get(source.id)?.pause();
        currentMsById.value = { ...currentMsById.value, [source.id]: 0 };
        if (editorProjectId.value === source.id) {
          editorPlayer.value?.pause();
          editorProjectId.value = undefined;
        }
        if (editorialTarget.value?.projectId === source.id)
          editorialTarget.value = undefined;
        if (assemblyTarget.value?.projectId === source.id)
          assemblyTarget.value = undefined;
      }
    }
  },
  { deep: true, immediate: true },
);
watch(
  () => historyQueries.value.map((query) => query.data?.items),
  (histories) => {
    histories.forEach((jobs, index) => {
      const id = ids.value[index];
      if (id && jobs) {
        const state = ensureState(id);
        const currentSource = projectQueries.value[index]?.data?.source;
        if (
          !currentSource ||
          state.sourceIdentity !==
            `${currentSource.id}:${currentSource.sourceVersion}`
        )
          return;
        state.jobs = [
          ...jobs.map((job) => job.id),
          ...state.jobs.filter(
            (jobId) => !jobs.some((job) => job.id === jobId),
          ),
        ];
        for (const job of jobs) {
          const current = queryClient.getQueryData<typeof job>([
            "pipeline-job",
            job.id,
          ]);
          if (!current || current.revision <= job.revision) {
            queryClient.setQueryData(["pipeline-job", job.id], job);
          }
        }
      }
    });
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
      <Button as-child>
        <NuxtLink
          class="action-link"
          :to="{ path: '/library', query: { returnTo: route.fullPath } }"
          >Добавить видео</NuxtLink
        >
      </Button>
    </header>
    <p v-if="normalized.removed" class="warning" role="status">
      Некоторые ссылки на видео недействительны и не были открыты.
    </p>
    <section v-if="!ids.length" class="empty">
      <p>Здесь появятся выбранные исходники и их таймкоды.</p>
      <NuxtLink to="/library">Выбрать видео в медиатеке</NuxtLink>
    </section>
    <section v-else class="source-grid" aria-label="Выбранные исходные видео">
      <Card v-for="(row, rowIndex) in rows" :key="row.id" class="source-card">
        <template #content>
          <p v-if="row.query.isLoading">Загружаем исходное видео…</p>
          <div v-else-if="row.query.isError" class="error">
            <h2>Видео недоступно</h2>
            <p>Не удалось открыть этот источник.</p>
            <Button severity="secondary" @click="removeSource(row.id)"
              >Убрать</Button
            >
          </div>
          <template v-else-if="row.query.data">
            <div class="card-heading">
              <div
                class="filename"
                :title="row.query.data.source.originalFilename"
              >
                {{ row.query.data.source.originalFilename }}
              </div>
              <div class="meta">
                {{ row.query.data.name }} ·
                {{
                  row.query.data.source.durationMs === undefined
                    ? "длительность проверяется"
                    : formatDisplayTimecode(row.query.data.source.durationMs)
                }}
              </div>
            </div>
            <video
              v-if="
                row.query.data.status === 'SOURCE_READY' &&
                row.query.data.source.authorization.usable
              "
              :key="`${row.query.data.source.id}:${row.query.data.source.sourceVersion}`"
              :ref="(element) => setPlayer(row.id, element)"
              controls
              preload="metadata"
              :src="mediaApi.sourceUrl(row.id)"
              :aria-label="`Просмотр исходного видео: ${row.query.data.source.originalFilename}`"
              @play="keepSinglePlayer"
              @timeupdate="updateCurrentTime(row.id, $event)"
            />
            <p v-else class="warning">
              {{
                row.query.data.status !== "SOURCE_READY"
                  ? "Исходник пока недоступен для нарезки."
                  : "Просмотр и нарезка заблокированы: права не подтверждены."
              }}
            </p>
            <p class="position">
              Позиция:
              <strong>{{
                formatDisplayTimecode(currentMsById[row.id] ?? 0)
              }}</strong>
            </p>
            <div class="card-actions">
              <Button
                label="Настроить нарезки"
                icon="pi pi-cog"
                :disabled="
                  row.query.data.status !== 'SOURCE_READY' ||
                  !row.query.data.source.authorization.usable
                "
                @click="openEditor(row.id)"
              />
              <Button
                label="Убрать"
                severity="secondary"
                outlined
                @click="removeSource(row.id)"
              />
            </div>
            <p
              v-if="historyQueries[rowIndex]?.isLoading"
              class="muted"
              role="status"
            >
              Восстанавливаем историю нарезок…
            </p>
            <div
              v-else-if="historyQueries[rowIndex]?.isError"
              class="warning"
              role="alert"
            >
              <p>Не удалось восстановить сохранённые нарезки.</p>
              <Button
                label="Повторить загрузку истории"
                severity="secondary"
                @click="historyQueries[rowIndex]?.refetch()"
              />
            </div>
            <section
              v-if="ensureState(row.id).jobs.length"
              class="card-jobs"
              :aria-label="`Статус нарезок ${row.query.data.source.originalFilename}`"
            >
              <h2>Нарезки</h2>
              <PipelineJobCard
                v-for="jobId in ensureState(row.id).jobs"
                :key="jobId"
                :job-id="jobId"
                :project-id="row.id"
                @clone-segment="cloneSegment(row.id, $event)"
                @edit-editorial="
                  openEditorial(
                    row.id,
                    $event,
                    row.query.data!.source.originalFilename,
                  )
                "
                @edit-assembly="
                  openAssembly(
                    row.id,
                    $event.jobId,
                    row.query.data!.source.originalFilename,
                    $event.durationMs,
                  )
                "
              />
            </section>
          </template>
        </template>
      </Card>
    </section>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>

    <Dialog
      :visible="editorProjectId !== undefined"
      modal
      :draggable="false"
      :style="{ width: 'min(38rem, calc(100vw - 2rem))' }"
      :pt="{
        root: { class: 'cut-dialog-root' },
        mask: { class: 'cut-dialog-mask' },
        header: { class: 'cut-dialog-header' },
        title: { class: 'cut-dialog-title' },
        closeButton: { class: 'cut-dialog-close' },
        content: { class: 'cut-dialog-body' },
      }"
      :header="
        editorProject
          ? `Нарезки · ${editorProject.source.originalFilename}`
          : 'Настройка нарезки'
      "
      @update:visible="editorProjectId = $event ? editorProjectId : undefined"
    >
      <div v-if="editorProject && editorProjectId" class="dialog-content">
        <div class="editor-player-wrap">
          <video
            :key="`${editorProject.source.id}:${editorProject.source.sourceVersion}`"
            ref="editorPlayer"
            controls
            preload="metadata"
            :src="mediaApi.sourceUrl(editorProjectId)"
            :aria-label="`Редактор исходного видео: ${editorProject.source.originalFilename}`"
            @play="keepSinglePlayer"
            @timeupdate="updateCurrentTime(editorProjectId, $event)"
          />
        </div>
        <div class="editor-toolbar">
          <p>
            Позиция:
            <strong>{{
              formatDisplayTimecode(currentMsById[editorProjectId] ?? 0)
            }}</strong>
          </p>
          <div class="marker-actions">
            <Button
              label="Установить начало"
              severity="secondary"
              @click="setMarker('startText')"
            />
            <Button
              label="Установить конец"
              severity="secondary"
              @click="setMarker('endText')"
            />
          </div>
        </div>
        <form
          @submit.prevent="
            submit(editorProjectId, editorProject.source.durationMs)
          "
        >
          <article
            v-for="(draft, index) in ensureState(editorProjectId).drafts"
            :key="draft.clientKey"
            class="segment"
          >
            <h3>Отрезок {{ index + 1 }}</h3>
            <div class="time-fields">
              <label :for="`horizontal-${editorProjectId}-${index}-start`"
                >Начало
                <InputText
                  :id="`horizontal-${editorProjectId}-${index}-start`"
                  v-model="draft.startText"
                  placeholder="00:00:00"
                  :invalid="
                    Boolean(
                      draftError(
                        editorProjectId,
                        draft,
                        editorProject.source.durationMs,
                      ),
                    )
                  "
                  @focus="ensureState(editorProjectId).activeSegment = index"
                  @input="clearConfirmation(editorProjectId)"
                  @blur="normalizeField(draft, 'startText')"
                />
              </label>
              <label :for="`horizontal-${editorProjectId}-${index}-end`"
                >Конец
                <InputText
                  :id="`horizontal-${editorProjectId}-${index}-end`"
                  v-model="draft.endText"
                  placeholder="00:00:10"
                  :invalid="
                    Boolean(
                      draftError(
                        editorProjectId,
                        draft,
                        editorProject.source.durationMs,
                      ),
                    )
                  "
                  @focus="ensureState(editorProjectId).activeSegment = index"
                  @input="clearConfirmation(editorProjectId)"
                  @blur="normalizeField(draft, 'endText')"
                />
              </label>
            </div>
            <p
              v-if="
                draftError(
                  editorProjectId,
                  draft,
                  editorProject.source.durationMs,
                )
              "
              class="error"
            >
              {{
                draftError(
                  editorProjectId,
                  draft,
                  editorProject.source.durationMs,
                )
              }}
            </p>
            <Button
              label="Удалить отрезок"
              severity="secondary"
              text
              @click="removeSegment(editorProjectId, index)"
            />
          </article>
          <section
            v-if="ensureState(editorProjectId).confirmation"
            class="confirmation"
          >
            <h3>Проверьте параметры перед запуском</h3>
            <ol>
              <li
                v-for="(segment, index) in ensureState(editorProjectId)
                  .confirmation?.segments ?? []"
                :key="segment.clientSegmentId"
              >
                Отрезок {{ index + 1 }}:
                {{ formatDisplayTimecode(segment.startMs) }}–{{
                  formatDisplayTimecode(segment.endMs)
                }}
                · длительность
                {{ formatDisplayTimecode(segment.endMs - segment.startMs) }}
              </li>
            </ol>
            <p>
              Всего материала:
              {{
                formatDisplayTimecode(
                  ensureState(editorProjectId).confirmation?.totalDurationMs ??
                    0,
                )
              }}.
            </p>
          </section>
          <p
            v-if="ensureState(editorProjectId).error"
            class="error"
            role="alert"
          >
            {{ ensureState(editorProjectId).error }}
          </p>
          <div class="dialog-actions">
            <Button
              label="Добавить отрезок"
              severity="secondary"
              outlined
              @click="addSegment(editorProjectId)"
            />
            <Button
              v-if="!ensureState(editorProjectId).confirmation"
              label="Проверить параметры"
              :disabled="
                editorProject.source.durationMs === undefined ||
                ensureState(editorProjectId).submitting
              "
              @click="
                requestConfirmation(
                  editorProjectId,
                  editorProject.source.durationMs,
                )
              "
            />
            <Button
              v-else
              type="submit"
              :label="
                ensureState(editorProjectId).submitting
                  ? 'Создаём задания…'
                  : `Запустить нарезку (${ensureState(editorProjectId).confirmation?.segments.length ?? 0})`
              "
              :disabled="
                editorProject.source.durationMs === undefined ||
                ensureState(editorProjectId).submitting
              "
            />
          </div>
        </form>
      </div>
    </Dialog>
    <EditorialPackageDialog
      v-if="editorialTarget"
      :key="`${editorialTarget.projectId}:${editorialTarget.jobId}`"
      :visible="true"
      :project-id="editorialTarget.projectId"
      :job-id="editorialTarget.jobId"
      :filename="editorialTarget.filename"
      @update:visible="
        (visible) => {
          if (!visible) editorialTarget = undefined;
        }
      "
    />
    <AssemblyRecipeDialog
      v-if="assemblyTarget"
      :key="`${assemblyTarget.projectId}:${assemblyTarget.jobId}`"
      :visible="true"
      :project-id="assemblyTarget.projectId"
      :job-id="assemblyTarget.jobId"
      :filename="assemblyTarget.filename"
      :cut-duration-ms="assemblyTarget.durationMs"
      @update:visible="
        (visible) => {
          if (!visible) assemblyTarget = undefined;
        }
      "
    />
  </main>
</template>

<style scoped>
.workspace {
  box-sizing: border-box;
  max-width: 120rem;
  margin: 0 auto;
  padding: 2rem clamp(1rem, 3vw, 3rem) 5rem;
}
.header {
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
.source-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  margin-top: 1rem;
  align-items: start;
}
.source-card {
  min-width: 0;
  overflow: hidden;
}
.card-heading {
  min-width: 0;
  margin-bottom: 0.75rem;
}
.filename {
  overflow: hidden;
  font-size: 1rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta,
.position {
  color: #65736b;
  font-size: 0.875rem;
}
video {
  display: block;
  aspect-ratio: 16 / 9;
  width: 100%;
  object-fit: contain;
  background: #111;
  border-radius: 0.5rem;
}
.card-jobs {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #d9e0d8;
}
.card-jobs h2 {
  margin: 0;
  font-size: 1rem;
}
.card-actions,
.marker-actions,
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.segment {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border-top: 1px solid #d9e0d8;
}
.segment h3 {
  margin: 0;
}
.time-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.time-fields label {
  display: grid;
  gap: 0.35rem;
  font-weight: 650;
}
.time-fields :deep(.p-inputtext) {
  width: 100%;
}
.time-fields :deep(input) {
  box-sizing: border-box;
  min-height: 2.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid #9aa89f;
  border-radius: 0.45rem;
  background: #fff;
}
.time-fields :deep(input:focus) {
  outline: 3px solid rgb(35 77 53 / 0.24);
  outline-offset: 1px;
  border-color: #234d35;
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
.confirmation {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 0.75rem;
  background: #edf7ef;
}
.dialog-content {
  display: grid;
  gap: 0.75rem;
  max-height: min(42rem, calc(100vh - 10rem));
  overflow-y: auto;
  padding-right: 0.25rem;
}
.editor-player-wrap {
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 0.5rem;
  background: #111;
}
.editor-player-wrap video {
  width: min(100%, 26rem);
  max-height: min(24vh, 10.5rem);
  aspect-ratio: 16 / 9;
}
.editor-toolbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.editor-toolbar p {
  margin: 0;
}
.dialog-actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding: 0.75rem 0 0.25rem;
  background: #fff;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
@media (min-width: 1280px) {
  .source-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (min-width: 1600px) {
  .source-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>

<style>
/* Dialog is teleported to body: these must not be scoped to the workspace. */
.cut-dialog-root {
  position: relative;
  display: flex;
  flex-direction: column;
  z-index: 1101;
  width: min(38rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  overflow: hidden;
  border: 1px solid #d9e0d8;
  border-radius: 0.875rem;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 0.28);
}
.cut-dialog-header {
  display: flex;
  flex: 0 0 auto;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid #d9e0d8;
}
.cut-dialog-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cut-dialog-close {
  display: inline-grid;
  flex: 0 0 2rem;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}
.cut-dialog-close:hover,
.cut-dialog-close:focus-visible {
  background: #edf2ee;
}
.cut-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
}
.cut-dialog-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100 !important;
  box-sizing: border-box;
  padding: 1rem;
  background: rgb(15 23 42 / 0.48);
}
</style>
