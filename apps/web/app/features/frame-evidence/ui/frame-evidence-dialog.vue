<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { createCreatorContextApi } from "~/shared/api/creator-context";
import {
  createFrameEvidenceApi,
  FrameEvidenceApiError,
  frameActive,
  type FrameEvidence,
  type FrameScope,
} from "~/shared/api/frame-evidence";
import { formatTimecode } from "~/shared/lib/timecode";
import {
  beginFrameRequest,
  finishFrameRequest,
  readPendingFrameRequest,
  type PendingFrameRequest,
} from "~/features/frame-evidence/model/attempt-storage";

const props = defineProps<{
  visible: boolean;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  jobId: string;
  filename: string;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  editContext: [];
}>();
const config = useRuntimeConfig();
const api = createFrameEvidenceApi(config.public.apiBasePath);
const contextApi = createCreatorContextApi(config.public.apiBasePath);
const client = useQueryClient();
const scope = computed<FrameScope>(() => ({
  projectId: props.projectId,
  sourceId: props.sourceId,
  sourceVersion: props.sourceVersion,
  cutPipelineJobId: props.jobId,
}));
const identity = computed(() => JSON.stringify(scope.value));
const selectedId = ref<string | null>(null);
const cursor = ref<string | null>(null);
const pending = ref<PendingFrameRequest | null>(null);
const storageError = ref<string | null>(null);
const error = ref<string | null>(null);
const imageErrors = ref<string[]>([]);
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
watch(
  identity,
  () => {
    selectedId.value = null;
    cursor.value = null;
    error.value = null;
    imageErrors.value = [];
    try {
      pending.value = readPendingFrameRequest(scope.value);
      storageError.value = null;
    } catch (cause) {
      storageError.value = message(cause);
      pending.value = null;
    }
  },
  { immediate: true },
);
const enabled = computed(() => props.visible);
const list = useQuery({
  queryKey: computed(() => [
    "frame-evidence-list",
    identity.value,
    cursor.value,
  ]),
  queryFn: () => api.list(scope.value, cursor.value),
  enabled,
  retry: false,
  refetchInterval: (query) =>
    query.state.data?.items.some(frameActive)
      ? document.hidden
        ? 15000
        : 3000
      : false,
});
const activeId = computed(
  () => selectedId.value ?? list.data.value?.items[0]?.id ?? null,
);
const detail = useQuery({
  queryKey: computed(() => ["frame-evidence", identity.value, activeId.value]),
  queryFn: () => api.get(activeId.value!, scope.value),
  enabled: computed(() => enabled.value && activeId.value !== null),
  retry: false,
  refetchInterval: (query) =>
    query.state.data && frameActive(query.state.data)
      ? document.hidden
        ? 15000
        : 2000
      : false,
});
const prompt = useQuery({
  queryKey: computed(() => ["cut-prompt", props.jobId, props.sourceVersion]),
  queryFn: () => contextApi.getCutPrompt(props.jobId),
  enabled,
  retry: false,
});
const context = useQuery({
  queryKey: computed(() => [
    "source-context",
    props.projectId,
    props.sourceId,
    props.sourceVersion,
  ]),
  queryFn: () =>
    contextApi.getSourceContext(
      props.projectId,
      props.sourceId,
      props.sourceVersion,
    ),
  enabled,
  retry: false,
});
const currentBody = computed(() => {
  const p = prompt.data.value?.revision,
    c = context.data.value?.revision;
  if (
    prompt.isError.value ||
    context.isError.value ||
    prompt.isFetching.value ||
    context.isFetching.value ||
    !p ||
    !c ||
    p.status !== "CURRENT" ||
    c.status !== "CURRENT" ||
    p.blockers.length ||
    c.blockers.length ||
    p.projectId !== props.projectId ||
    p.sourceId !== props.sourceId ||
    p.sourceVersion !== props.sourceVersion ||
    c.projectId !== props.projectId ||
    c.sourceId !== props.sourceId ||
    c.sourceVersion !== props.sourceVersion ||
    p.cutPipelineJobId !== props.jobId ||
    p.sourceContextRevisionId !== c.id
  )
    return null;
  return { sourceContextRevisionId: c.id, cutPromptRevisionId: p.id };
});
const admissionEnabled = computed(
  () =>
    config.public.aiContextEnabled === true &&
    config.public.editorialFramesEnabled === true,
);
const activeWork = computed(
  () =>
    list.data.value?.items.some(frameActive) ||
    (detail.data.value && frameActive(detail.data.value)),
);
const mutation = useMutation({
  mutationFn: (request: PendingFrameRequest) =>
    api.create(request.scope, request.body, request.key),
});
const canRequest = computed(
  () =>
    !mutation.isPending.value &&
    !storageError.value &&
    admissionEnabled.value &&
    (pending.value !== null ||
      (cursor.value === null &&
        currentBody.value !== null &&
        !activeWork.value &&
        !list.isPending.value &&
        !list.isError.value)),
);
const value = computed(() => detail.data.value);
const phaseLabels: Record<string, string> = {
  READ_INPUT: "Чтение нарезки",
  EXTRACT: "Извлечение кадров",
  HASH: "Проверка изображений",
  UPLOAD: "Сохранение изображений",
  FINALIZE: "Завершение",
};
function status(item: FrameEvidence): string {
  if (item.job.state === "QUEUED" && item.job.admissionReason)
    return "Ожидание ресурсов";
  return {
    QUEUED: "В очереди",
    PROCESSING: "Обработка",
    RETRY_WAIT: "Ожидание повторной попытки",
    READY: "Готово",
    FAILED_FINAL: "Не удалось подготовить",
  }[item.job.state];
}
function message(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Не удалось выполнить действие.";
}
async function create(): Promise<void> {
  if (!canRequest.value) return;
  const target = identity.value;
  error.value = null;
  let request: PendingFrameRequest;
  try {
    request =
      pending.value ?? beginFrameRequest(scope.value, currentBody.value!);
    pending.value = request;
  } catch (cause) {
    storageError.value = message(cause);
    return;
  }
  try {
    const result = await mutation.mutateAsync(request);
    finishFrameRequest(request);
    const targetIdentity = JSON.stringify(request.scope);
    client.setQueryData(["frame-evidence", targetIdentity, result.id], result);
    void client.invalidateQueries({
      queryKey: ["frame-evidence-list", targetIdentity],
    });
    if (!alive || target !== identity.value) return;
    pending.value = readPendingFrameRequest(request.scope);
    selectedId.value = result.id;
    cursor.value = null;
    imageErrors.value = [];
  } catch (cause) {
    // Only explicit pre-admission rejection proves this request did not create an intent.
    if (
      cause instanceof FrameEvidenceApiError &&
      [400, 404, 409, 422].includes(cause.status) &&
      [
        "FRAME_CONTEXT_REQUIRED",
        "SOURCE_AUTHORIZATION_REQUIRED",
        "FRAME_INPUT_UNSUPPORTED",
        "IDEMPOTENCY_CONFLICT",
        "VALIDATION_FAILED",
        "IDEMPOTENCY_KEY_INVALID",
      ].includes(cause.code)
    ) {
      finishFrameRequest(request);
    }
    if (!alive || target !== identity.value) return;
    try {
      pending.value = readPendingFrameRequest(request.scope);
    } catch (storageCause) {
      storageError.value = message(storageCause);
    }
    error.value = message(cause);
    void prompt.refetch();
    void context.refetch();
    void list.refetch();
  }
}
async function refresh(): Promise<void> {
  imageErrors.value = [];
  error.value = null;
  try {
    pending.value = readPendingFrameRequest(scope.value);
    storageError.value = null;
  } catch (cause) {
    storageError.value = message(cause);
  }
  await Promise.allSettled([
    list.refetch(),
    prompt.refetch(),
    context.refetch(),
    ...(activeId.value ? [detail.refetch()] : []),
  ]);
}
function imageFailed(id: string): void {
  if (imageErrors.value.includes(id)) return;
  imageErrors.value.push(id);
  void detail.refetch();
}
function nextPage(): void {
  if (list.data.value?.nextCursor) {
    cursor.value = list.data.value.nextCursor;
    selectedId.value = null;
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :header="`Кадры нарезки · ${filename}`"
    :style="{ width: 'min(64rem, calc(100vw - 2rem))' }"
    :pt="{
      root: { class: 'frame-dialog-root' },
      mask: { class: 'frame-dialog-mask' },
      header: { class: 'frame-dialog-header' },
      title: { class: 'frame-dialog-title' },
      pcCloseButton: { root: { class: 'frame-dialog-close' } },
      content: { class: 'frame-dialog-body' },
    }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="frame-panel">
      <p>
        Три равномерно выбранных кадра отрезка помогут подготовить оформление.
        Ручная обложка и экспорт доступны независимо.
      </p>
      <div class="frame-actions">
        <Button type="button" :disabled="!canRequest" @click="create">{{
          mutation.isPending.value
            ? "Отправляем запрос…"
            : pending
              ? "Уточнить результат запроса"
              : value
                ? "Подготовить новый набор"
                : "Подготовить три кадра"
        }}</Button>
        <Button type="button" severity="secondary" @click="refresh"
          >Обновить данные</Button
        >
        <Button type="button" severity="secondary" @click="emit('editContext')"
          >Открыть контекст нарезки</Button
        >
      </div>
      <p v-if="!admissionEnabled" class="frame-warning">
        Создание новых наборов кадров отключено. Сохранённая история остаётся
        доступна.
      </p>
      <p v-else-if="!currentBody && !pending" class="frame-warning">
        Для нового набора сохраните актуальные контекст исходника и prompt
        нарезки. Фотография автора не требуется.
      </p>
      <p v-if="pending" class="frame-warning" role="status">
        Результат предыдущего запроса ещё не подтверждён. Кнопка уточнения
        повторит именно его, в том числе после перезагрузки страницы.
      </p>
      <p v-if="storageError || error" class="frame-error" role="alert">
        {{ storageError || error }}
      </p>
      <p v-if="list.isPending.value">Загружаем историю…</p>
      <p v-else-if="list.isError.value" class="frame-error" role="alert">
        Не удалось обновить историю наборов. Обновите данные.
      </p>
      <template v-else-if="list.data.value">
        <p v-if="list.data.value.items.length === 0">
          Для этой нарезки наборы кадров ещё не запрашивались.
        </p>
        <label v-else class="frame-choice"
          >Сохранённые наборы
          <select
            :value="activeId"
            @change="
              selectedId = ($event.target as HTMLSelectElement).value;
              imageErrors = [];
            "
          >
            <option
              v-for="item in list.data.value.items"
              :key="item.id"
              :value="item.id"
            >
              {{ new Date(item.createdAt).toLocaleString("ru-RU") }} ·
              {{ status(item) }} · {{ item.id.slice(0, 8) }}
            </option>
          </select>
        </label>
        <div v-if="cursor || list.data.value.nextCursor" class="frame-actions">
          <Button
            v-if="cursor"
            severity="secondary"
            @click="
              cursor = null;
              selectedId = null;
            "
            >К новым наборам</Button
          >
          <Button
            v-if="list.data.value.nextCursor"
            severity="secondary"
            @click="nextPage"
            >Более ранние наборы</Button
          >
        </div>
        <p v-if="cursor">
          Для нового запроса вернитесь к новым наборам, чтобы проверить активные
          задания.
        </p>
      </template>
      <p v-if="activeId && detail.isPending.value">Загружаем набор кадров…</p>
      <p v-else-if="detail.isError.value" class="frame-error" role="alert">
        Не удалось проверить состояние набора. Изображения скрыты до обновления.
      </p>
      <article
        v-else-if="value"
        class="frame-result"
        :aria-busy="frameActive(value)"
      >
        <h2>{{ status(value) }}</h2>
        <p v-if="value.job.admissionReason" role="status">
          Задание сохранено и ожидает свободных ресурсов. Ожидание не расходует
          попытки обработки.
        </p>
        <p v-if="value.job.state === 'RETRY_WAIT'">
          Обработка повторится автоматически{{
            value.job.nextAttemptAt
              ? ` после ${new Date(value.job.nextAttemptAt).toLocaleTimeString("ru-RU")}`
              : ""
          }}.
        </p>
        <div v-if="value.job.state === 'PROCESSING'" role="status">
          <p>
            {{
              value.job.progress
                ? phaseLabels[value.job.progress.phase]
                : "Обработка началась"
            }}
            · попытка {{ value.job.attempt }}
          </p>
          <template v-if="value.job.progress">
            <progress
              :value="value.job.progress.basisPoints"
              max="10000"
              aria-label="Прогресс подготовки кадров"
            />
            <p>
              {{ Math.floor(value.job.progress.basisPoints / 100) }}% · кадров:
              {{ value.job.progress.completedFrameCount }} из 3
            </p>
          </template>
          <progress v-else aria-label="Подготовка кадров" />
        </div>
        <p v-if="value.job.failure" class="frame-error" role="alert">
          {{ value.job.failure.message }} ({{ value.job.failure.code }})
        </p>
        <p v-if="value.currentUse.blockers.length" class="frame-warning">
          Контекст этого набора устарел или недоступен. Для дальнейшего
          использования сохраните актуальный контекст и явно запросите новый
          набор.
        </p>
        <p v-if="!value.contentAccess.bytesReadable" class="frame-warning">
          Просмотр кадров закрыт: для этой версии исходника нет действующего
          разрешения.
        </p>
        <div
          v-if="
            value.job.state === 'READY' && value.contentAccess.bytesReadable
          "
          class="frame-gallery"
        >
          <figure v-for="frame in value.frames" :key="frame.id">
            <a
              v-if="!imageErrors.includes(frame.id)"
              :href="api.contentUrl(value.id, frame.id)"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                :src="api.contentUrl(value.id, frame.id)"
                :width="frame.measurement.width"
                :height="frame.measurement.height"
                :alt="`Кадр ${frame.measurement.ordinal + 1}, ${formatTimecode(frame.measurement.actualCutMs)} от начала нарезки`"
                @error="imageFailed(frame.id)"
              />
            </a>
            <p v-else class="frame-error">
              Изображение недоступно. Обновите данные, чтобы повторить проверку.
            </p>
            <figcaption>
              Кадр {{ frame.measurement.ordinal + 1 }} ·
              {{ formatTimecode(frame.measurement.actualCutMs) }} от начала
              нарезки<br />Позиция в исходнике:
              {{ formatTimecode(frame.measurement.mappedSourceMs) }}
            </figcaption>
          </figure>
        </div>
        <details>
          <summary>Версии и точные данные набора</summary>
          <dl class="frame-lineage">
            <dt>Набор</dt>
            <dd>{{ value.id }}</dd>
            <dt>Нарезка</dt>
            <dd>{{ value.identity.cutPipelineJobId }}</dd>
            <dt>Версия исходника</dt>
            <dd>{{ value.identity.sourceVersion }}</dd>
            <dt>Контекст / prompt / профиль</dt>
            <dd>
              {{ value.identity.sourceContextRevisionNo }} /
              {{ value.identity.cutPromptRevisionNo }} /
              {{ value.identity.creatorProfileRevisionNo }}
            </dd>
            <dt>SHA-256 нарезки</dt>
            <dd>{{ value.identity.cutResultSha256 }}</dd>
          </dl>
          <p>
            Фактический таймкод измерен по декодированному кадру. Позиция в
            исходнике рассчитана добавлением начала нарезки.
          </p>
          <p v-for="frame in value.frames" :key="frame.id">
            Кадр {{ frame.measurement.ordinal + 1 }}: запрос
            {{ formatTimecode(frame.measurement.requestedCutMs) }}, фактически
            {{ formatTimecode(frame.measurement.actualCutMs) }};
            {{ frame.measurement.width }}×{{ frame.measurement.height }};
            {{ frame.measurement.sizeBytes }} байт.
          </p>
        </details>
      </article>
    </div>
  </Dialog>
</template>

<style>
.frame-dialog-mask {
  z-index: 1200;
  padding: 1rem;
  background: rgb(15 23 42 / 0.45);
}
.frame-dialog-root {
  position: relative;
  z-index: 1201;
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 2rem);
  overflow: hidden;
  border: 1px solid #d9e0d8;
  border-radius: 0.875rem;
  background: #fff;
  color: #152018;
  box-shadow: 0 24px 80px rgb(15 23 42 / 0.3);
}
.frame-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid #d9e0d8;
}
.frame-dialog-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 700;
  white-space: nowrap;
}
.frame-dialog-close {
  display: inline-grid;
  flex: 0 0 2.5rem;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  border: 0;
  border-radius: 99px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.frame-dialog-close:focus-visible,
.frame-dialog-close:hover {
  background: #edf2ee;
  outline: 2px solid #234d35;
}
.frame-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem;
}
</style>
<style scoped>
.frame-panel {
  display: grid;
  gap: 1rem;
}
.frame-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.frame-warning {
  padding: 0.7rem;
  border-radius: 0.5rem;
  background: #fff7d6;
  color: #7c4a03;
}
.frame-error {
  color: #991b1b;
}
.frame-choice {
  display: grid;
  gap: 0.5rem;
}
select {
  width: 100%;
  min-height: 2.75rem;
  padding: 0.5rem;
  border: 1px solid #9aa89f;
  border-radius: 0.5rem;
  background: #fff;
  color: inherit;
}
.frame-result {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.frame-gallery {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
figure {
  min-width: 0;
  margin: 0;
}
img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 0.5rem;
}
figcaption {
  margin-top: 0.5rem;
  font-size: 0.9rem;
}
.frame-lineage {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) minmax(0, 3fr);
  gap: 0.5rem;
}
dd {
  overflow-wrap: anywhere;
  margin: 0;
}
progress {
  width: 100%;
}
@media (max-width: 700px) {
  .frame-gallery,
  .frame-lineage {
    grid-template-columns: 1fr;
  }
}
</style>
