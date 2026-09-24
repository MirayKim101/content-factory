<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import {
  approvalIdempotency,
  clearApprovalDraft,
  loadApprovalDraft,
  saveApprovalDraft,
} from "~/features/review-editorial-package/model/approval-draft";
import {
  clearExportAttempt,
  exportIdempotency,
  saveExportAttempt,
} from "~/features/export-editorial-package/model/export-attempt-storage";
import {
  createEditorialApprovalsApi,
  type CreateEditorialApproval,
  EditorialApprovalApiError,
  type EditorialReview,
} from "~/shared/api/editorial-approvals";
import {
  createEditorialExportsApi,
  EditorialExportsApiError,
} from "~/shared/api/editorial-exports";

const props = defineProps<{
  visible: boolean;
  projectId: string;
  jobId: string;
  renderId: string;
  filename: string;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  exportCreated: [payload: { projectId: string; exportId: string }];
}>();
const config = useRuntimeConfig();
const api = createEditorialApprovalsApi(config.public.apiBasePath);
const exportsApi = createEditorialExportsApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const checked = ref(false);
const preparationForegroundMs = ref(0);
const finalReviewForegroundMs = ref(0);
const draftFingerprint = ref<string>();
const draftJobId = ref<string>();
const idempotencyKey = ref<string>();
const error = ref<string>();
const exportError = ref<string>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let foregroundStart: number | undefined;
let foregroundPhase: "PREPARATION" | "FINAL_REVIEW" | undefined;

const review = useQuery({
  queryKey: computed(() => ["editorial-review", props.projectId, props.jobId]),
  queryFn: () => api.review(props.jobId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: 1,
});
const candidate = computed(() => {
  const value = review.data.value;
  return value?.projectId === props.projectId &&
    value.cutPipelineJobId === props.jobId &&
    value.render?.id === props.renderId
    ? value
    : undefined;
});
const isCurrent = computed(
  () => candidate.value?.currentApproval?.state === "CURRENT",
);
const canApprove = computed(() =>
  Boolean(
    candidate.value?.approvable &&
    candidate.value.candidateFingerprint &&
    candidate.value.render &&
    candidate.value.blockers.length === 0 &&
    candidate.value.processingMetrics &&
    (candidate.value.integratedReviewEnabled ||
      candidate.value.workflowMode === "MANUAL") &&
    !isCurrent.value &&
    checked.value &&
    displayedAttention("PREPARATION") + displayedAttention("FINAL_REVIEW") <=
      28_800_000 &&
    !review.isFetching.value &&
    !approval.isPending.value,
  ),
);
const canExport = computed(
  () =>
    candidate.value?.currentApproval?.state === "CURRENT" &&
    !review.isFetching.value &&
    !exportMutation.isPending.value,
);

function addForegroundTime(): void {
  if (foregroundStart === undefined) return;
  const elapsed = Math.max(0, Date.now() - foregroundStart);
  if (foregroundPhase === "FINAL_REVIEW")
    finalReviewForegroundMs.value += elapsed;
  else preparationForegroundMs.value += elapsed;
  foregroundStart = undefined;
  foregroundPhase = undefined;
  persistDraft();
}
function isForeground(): boolean {
  return props.visible && document.visibilityState === "visible";
}
function syncTimer(): void {
  // An idempotency key means an exact approval tuple may already have reached
  // PostgreSQL. Its attention value is frozen until that request resolves.
  if (idempotencyKey.value) {
    addForegroundTime();
    return;
  }
  if (isForeground() && foregroundStart === undefined) {
    foregroundStart = Date.now();
    foregroundPhase = checked.value ? "FINAL_REVIEW" : "PREPARATION";
  }
  if (!isForeground()) addForegroundTime();
}
function onVisibilityChange(): void {
  syncTimer();
}
function startTimer(): void {
  document.addEventListener("visibilitychange", onVisibilityChange);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
  syncTimer();
}
function stopTimer(): void {
  addForegroundTime();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (timer) clearInterval(timer);
  timer = undefined;
}
function displayedAttention(phase: "PREPARATION" | "FINAL_REVIEW"): number {
  return (
    (phase === "PREPARATION"
      ? preparationForegroundMs.value
      : finalReviewForegroundMs.value) +
    (foregroundStart === undefined || foregroundPhase !== phase
      ? 0
      : Math.max(0, now.value - foregroundStart))
  );
}
function persistDraft(): void {
  if (!draftFingerprint.value || !draftJobId.value) return;
  saveApprovalDraft(draftJobId.value, {
    candidateFingerprint: draftFingerprint.value,
    preparationForegroundMs: preparationForegroundMs.value,
    finalReviewForegroundMs: finalReviewForegroundMs.value,
    idempotencyKey: idempotencyKey.value,
  });
}
function hydrateDraft(value: EditorialReview | undefined): void {
  const fingerprint = value?.candidateFingerprint;
  if (!fingerprint || fingerprint === draftFingerprint.value) return;
  addForegroundTime();
  const draft = loadApprovalDraft(props.jobId, fingerprint);
  draftFingerprint.value = fingerprint;
  draftJobId.value = props.jobId;
  preparationForegroundMs.value = draft.preparationForegroundMs;
  finalReviewForegroundMs.value = draft.finalReviewForegroundMs;
  idempotencyKey.value = draft.idempotencyKey;
  checked.value = false;
  error.value = undefined;
  now.value = Date.now();
  if (isForeground() && !idempotencyKey.value) {
    foregroundStart = now.value;
    foregroundPhase = "PREPARATION";
  }
}
function close(): void {
  stopTimer();
  persistDraft();
  emit("update:visible", false);
}
function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Нет достоверных данных";
  const seconds = Math.round(value / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours} ч ${minutes} мин`
    : minutes
      ? `${minutes} мин ${remainder} с`
      : `${remainder} с`;
}
function formatBytes(value: string | undefined): string {
  if (!value) return "Нет данных";
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value} байт`;
  return bytes >= 1_073_741_824
    ? `${(bytes / 1_073_741_824).toFixed(2)} ГиБ`
    : `${(bytes / 1_048_576).toFixed(1)} МиБ`;
}
function metric(value: number | null): string {
  return value === null ? "Нет достоверных данных" : formatDuration(value);
}
function formatMicrousd(value: string): string {
  return `$${(Number(value) / 1_000_000).toFixed(6)} (${value} microUSD)`;
}
function modeLabel(value: "MANUAL" | "AI_ASSISTED" | "MIXED"): string {
  return value === "MANUAL"
    ? "Ручной"
    : value === "AI_ASSISTED"
      ? "AI без содержательных правок"
      : "Смешанный";
}
function requestApproval(): void {
  const value = candidate.value;
  if (
    !value?.candidateFingerprint ||
    !value.render ||
    !value.editorial ||
    !canApprove.value
  )
    return;
  addForegroundTime();
  const draft = approvalIdempotency({
    candidateFingerprint: value.candidateFingerprint,
    preparationForegroundMs: preparationForegroundMs.value,
    finalReviewForegroundMs: finalReviewForegroundMs.value,
    idempotencyKey: idempotencyKey.value,
  });
  idempotencyKey.value = draft.idempotencyKey;
  persistDraft();
  approval.mutate({
    renderId: value.render.id,
    body: value.integratedReviewEnabled
      ? {
          approvalContractVersion: "human-horizontal-approval-v2",
          editorialRevision: value.editorial.revision,
          candidateFingerprint: value.candidateFingerprint,
          attention: {
            schemaVersion: "operator-attention-v2",
            preparationForegroundMs: draft.preparationForegroundMs,
            finalReviewForegroundMs: draft.finalReviewForegroundMs,
          },
        }
      : {
          approvalContractVersion: "manual-horizontal-approval-v1",
          editorialRevision: value.editorial.revision,
          candidateFingerprint: value.candidateFingerprint,
          manualAttentionMs:
            draft.preparationForegroundMs + draft.finalReviewForegroundMs,
          attentionMeasurementVersion: "foreground-preview-v1",
        },
    key: draft.idempotencyKey!,
    identity: `${props.projectId}:${props.jobId}:${props.renderId}:${value.candidateFingerprint}`,
  });
}
function requestExport(): void {
  const approval = candidate.value?.currentApproval;
  if (!approval || !canExport.value) return;
  const key = exportIdempotency(approval.id);
  saveExportAttempt(approval.id, key);
  exportError.value = undefined;
  exportMutation.mutate({
    approvalId: approval.id,
    key,
    identity: `${props.projectId}:${props.jobId}:${approval.id}`,
  });
}
const approval = useMutation({
  mutationFn: (request: {
    renderId: string;
    body: CreateEditorialApproval;
    key: string;
    identity: string;
  }) => api.approve(request.renderId, request.body, request.key),
  onSuccess: async (_result, request) => {
    if (
      request.identity !==
      `${props.projectId}:${props.jobId}:${props.renderId}:${candidate.value?.candidateFingerprint ?? ""}`
    )
      return;
    clearApprovalDraft(props.jobId);
    idempotencyKey.value = undefined;
    error.value = undefined;
    await queryClient.invalidateQueries({
      queryKey: ["editorial-review", props.projectId, props.jobId],
    });
  },
  onError: (reason, request) => {
    if (
      request.identity !==
      `${props.projectId}:${props.jobId}:${props.renderId}:${candidate.value?.candidateFingerprint ?? ""}`
    )
      return;
    error.value =
      reason instanceof EditorialApprovalApiError
        ? reason.status === 409
          ? "Версия изменилась или запрос конфликтует. Обновите проверку: подтверждение не создано."
          : reason.status === 503
            ? "Подтверждение временно выключено на сервере. Данные просмотра сохранены локально."
            : reason.status === 404
              ? "Сборка больше недоступна. Закройте окно и обновите список."
              : reason.message
        : "Не удалось подтвердить версию. Повторите запрос — он использует тот же ключ.";
  },
});
const exportMutation = useMutation({
  mutationFn: (request: {
    approvalId: string;
    key: string;
    identity: string;
  }) => exportsApi.create(request.approvalId, request.key),
  onSuccess: async (result, request) => {
    if (
      request.identity !==
      `${props.projectId}:${props.jobId}:${candidate.value?.currentApproval?.id ?? ""}`
    )
      return;
    clearExportAttempt(request.approvalId);
    exportError.value = undefined;
    queryClient.setQueryData(["editorial-export", result.id], result);
    await queryClient.invalidateQueries({
      queryKey: ["editorial-exports", props.projectId],
    });
    emit("exportCreated", { projectId: props.projectId, exportId: result.id });
  },
  onError: (reason, request) => {
    if (
      request.identity !==
      `${props.projectId}:${props.jobId}:${candidate.value?.currentApproval?.id ?? ""}`
    )
      return;
    exportError.value =
      reason instanceof EditorialExportsApiError
        ? reason.status === 409
          ? "Подтверждение перестало быть актуальным. Экспорт безопасно заблокирован. Обновите проверку."
          : reason.status === 503
            ? "Экспорт временно выключен на сервере. Версия не была поставлена в очередь."
            : reason.message
        : "Не удалось создать экспорт. Повторите запрос: он использует тот же ключ.";
  },
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) startTimer();
    else stopTimer();
  },
  { immediate: true },
);
watch(candidate, hydrateDraft, { immediate: true });
watch(
  () => [props.projectId, props.jobId, props.renderId],
  () => {
    stopTimer();
    draftFingerprint.value = undefined;
    draftJobId.value = undefined;
    preparationForegroundMs.value = 0;
    finalReviewForegroundMs.value = 0;
    idempotencyKey.value = undefined;
    checked.value = false;
    error.value = undefined;
    if (props.visible) startTimer();
  },
);
onBeforeUnmount(stopTimer);
watch(checked, () => {
  addForegroundTime();
  syncTimer();
});
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :style="{ width: 'min(72rem, calc(100vw - 2rem))' }"
    :header="`Проверка версии · ${filename}`"
    @update:visible="(value) => value || close()"
  >
    <section class="review-dialog">
      <p v-if="review.isLoading.value" role="status">
        Загружаем единую версию для проверки…
      </p>
      <template v-else-if="review.isError.value">
        <p class="error" role="alert">
          Не удалось получить безопасную версию для проверки. Подтверждение
          заблокировано.
        </p>
        <Button
          label="Повторить загрузку"
          severity="secondary"
          @click="review.refetch()"
        />
      </template>
      <template v-else-if="candidate">
        <section v-if="candidate.blockers.length" class="blockers" role="alert">
          <strong>Подтверждение пока недоступно</strong>
          <ul>
            <li v-for="blocker in candidate.blockers" :key="blocker">
              {{ blocker }}
            </li>
          </ul>
        </section>
        <section
          v-if="
            candidate.currentApproval ||
            candidate.latestApproval?.state === 'STALE'
          "
          class="approval-state"
          :class="
            candidate.currentApproval?.state === 'CURRENT' ? 'current' : 'stale'
          "
        >
          <strong>{{
            candidate.currentApproval?.state === "CURRENT"
              ? "Текущая версия подтверждена"
              : "Подтверждение устарело"
          }}</strong>
          <p v-if="candidate.currentApproval?.state === 'CURRENT'">
            Подтверждена revision
            {{ candidate.currentApproval.editorialRevision }}. ZIP-пакет можно
            создать ниже.
          </p>
          <p v-else>
            Причины:
            {{
              (
                candidate.currentApproval ?? candidate.latestApproval
              )?.staleReasons.join(", ") ||
              "версия больше не соответствует текущему пакету"
            }}.
          </p>
        </section>
        <template
          v-if="candidate.editorial && candidate.recipe && candidate.render"
        >
          <div class="preview-grid">
            <section>
              <h3>Готовое горизонтальное видео</h3>
              <video
                class="review-video"
                controls
                preload="metadata"
                :src="candidate.render.contentUrl"
                aria-label="Предпросмотр готового горизонтального видео"
              />
              <dl class="facts">
                <dt>Длительность</dt>
                <dd>{{ formatDuration(candidate.render.durationMs) }}</dd>
                <dt>Размер</dt>
                <dd>{{ formatBytes(candidate.render.artifactSizeBytes) }}</dd>
              </dl>
            </section>
            <section>
              <h3>Обложка</h3>
              <img
                class="thumbnail"
                :src="candidate.editorial.thumbnail.contentUrl"
                :alt="`Обложка: ${candidate.editorial.thumbnail.filename}`"
              />
              <p>
                {{ candidate.editorial.thumbnail.filename }} ·
                {{ formatBytes(candidate.editorial.thumbnail.sizeBytes) }}
              </p>
            </section>
          </div>
          <section class="metadata">
            <h3>{{ candidate.editorial.title }}</h3>
            <p class="description">{{ candidate.editorial.description }}</p>
            <ol class="tags">
              <li v-for="tag in candidate.editorial.tags" :key="tag">
                {{ tag }}
              </li>
            </ol>
          </section>
          <section
            class="component-review"
            aria-label="Происхождение компонентов"
          >
            <h3>Происхождение и стоимость</h3>
            <div class="metric-grid">
              <article>
                <strong
                  >Metadata ·
                  {{ modeLabel(candidate.components.metadata.mode) }}</strong
                >
                <p>
                  {{
                    formatMicrousd(
                      candidate.components.metadata.directCostMicrousd,
                    )
                  }}
                  ·
                  {{ candidate.components.metadata.costBasisVersion }}
                </p>
                <p v-if="candidate.components.metadata.research">
                  Research:
                  {{ candidate.components.metadata.research.freshness }} · до
                  {{
                    new Date(
                      candidate.components.metadata.research.freshUntil,
                    ).toLocaleString()
                  }}
                </p>
                <ul v-if="candidate.components.metadata.citations.length">
                  <li
                    v-for="citation in candidate.components.metadata.citations"
                    :key="citation.id"
                  >
                    <a
                      :href="citation.url"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {{ citation.title }} · {{ citation.publisher }}
                    </a>
                  </li>
                </ul>
                <p v-else>Фактические citations не использовались.</p>
              </article>
              <article>
                <strong
                  >Thumbnail ·
                  {{ modeLabel(candidate.components.thumbnail.mode) }}</strong
                >
                <p>
                  {{
                    formatMicrousd(
                      candidate.components.thumbnail.directCostMicrousd,
                    )
                  }}
                  ·
                  {{ candidate.components.thumbnail.costBasisVersion }}
                </p>
                <p>
                  Likeness:
                  {{
                    candidate.components.thumbnail.likeness ?? "не применялся"
                  }}. Safety decision сохранён сервером.
                </p>
              </article>
            </div>
            <p>
              Итоговый режим:
              <strong>{{ modeLabel(candidate.workflowMode) }}</strong> · AI
              direct cost:
              {{
                formatMicrousd(
                  candidate.economicsPreview.combinedDirectCostMicrousd,
                )
              }}. Электричество, оборудование и труд сюда не входят.
            </p>
          </section>
          <section class="revision">
            <h3>Зафиксированная версия</h3>
            <p>
              Metadata revision {{ candidate.editorial.revision }} · рецепт
              revision {{ candidate.recipe.revision }} · render contract
              {{ candidate.render.renderContractVersion }}
            </p>
          </section>
        </template>
        <section v-if="candidate.processingMetrics" class="metrics">
          <h3>Показатели обработки</h3>
          <p>
            Календарно от старта нарезки до готовой сборки:
            {{
              metric(candidate.processingMetrics.cutToAssemblyReadyElapsedMs)
            }}.
          </p>
          <div class="metric-grid">
            <p>
              <strong>Нарезка</strong><br />Очередь:
              {{ metric(candidate.processingMetrics.cut.initialQueueWaitMs)
              }}<br />Активная работа:
              {{ metric(candidate.processingMetrics.cut.activeAttemptMs)
              }}<br />Повторы: {{ candidate.processingMetrics.cut.retryCount }}
            </p>
            <p>
              <strong>Сборка</strong><br />Очередь:
              {{
                metric(candidate.processingMetrics.assembly.initialQueueWaitMs)
              }}<br />Активная работа:
              {{ metric(candidate.processingMetrics.assembly.activeAttemptMs)
              }}<br />Повторы:
              {{ candidate.processingMetrics.assembly.retryCount }}
            </p>
          </div>
          <p
            v-if="candidate.processingMetrics.incompleteReasons.length"
            class="warning"
          >
            Неполные данные:
            {{ candidate.processingMetrics.incompleteReasons.join(", ") }}.
          </p>
          <p>
            Прямые платные provider/API расходы: 0 ₽. Электричество, амортизация
            и ручная работа здесь не оценены.
          </p>
        </section>
        <section v-else class="warning">
          <strong>Показатели обработки пока недоступны.</strong> Подтверждение
          безопасно заблокировано, пока сервер не вернёт полный набор данных.
        </section>
        <section v-if="!isCurrent" class="approval-action">
          <p>
            Подготовка:
            <strong>{{
              formatDuration(displayedAttention("PREPARATION"))
            }}</strong>
            · финальная проверка:
            <strong>{{
              formatDuration(displayedAttention("FINAL_REVIEW"))
            }}</strong
            >. При закрытии окна или переходе вкладки счётчики останавливаются и
            сохраняется локально для этой точной версии.
          </p>
          <p v-if="idempotencyKey" class="warning" role="status">
            Предыдущий запрос ожидает безопасного повтора. Время проверки
            зафиксировано; повтор будет отправлен с теми же параметрами.
          </p>
          <label class="confirm"
            ><Checkbox v-model="checked" binary input-id="editorial-approve" />
            <span>Проверил и подтверждаю эту версию</span></label
          >
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <Button
            label="Подтвердить версию"
            :disabled="!canApprove"
            :loading="approval.isPending.value"
            @click="requestApproval"
          />
        </section>
        <section v-else class="export-next">
          <strong>Версия готова к экспорту.</strong>
          <p>
            Сервер создаст ZIP-пакет в фоне. После закрытия окна статус и
            скачивание останутся у этой нарезки.
          </p>
          <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
          <Button
            label="Экспортировать пакет"
            icon="pi pi-file-export"
            :disabled="!canExport"
            :loading="exportMutation.isPending.value"
            @click="requestExport"
          />
        </section>
      </template>
      <p v-else class="warning" role="alert">
        Эта сборка больше не является текущим кандидатом. Подтверждение
        заблокировано: закройте окно и откройте актуальную сборку.
      </p>
    </section>
  </Dialog>
</template>

<style scoped>
.review-dialog {
  display: grid;
  gap: 1rem;
  padding-bottom: 0.5rem;
}
.preview-grid,
.metric-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(14rem, 1fr);
  gap: 1rem;
}
.review-video,
.thumbnail {
  width: 100%;
  max-height: 23rem;
  object-fit: contain;
  border-radius: 0.6rem;
  background: #111;
}
.thumbnail {
  aspect-ratio: 16 / 9;
  object-fit: cover;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
}
.facts dt {
  color: #52635a;
}
.facts dd {
  margin: 0;
  font-weight: 700;
}
.metadata,
.revision,
.metrics,
.approval-action,
.export-next,
.blockers,
.approval-state {
  border: 1px solid #d5ddd7;
  border-radius: 0.65rem;
  padding: 0.85rem;
  background: #fff;
}
.metadata h3,
.metrics h3,
.revision h3 {
  margin-top: 0;
}
.description {
  white-space: pre-wrap;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0;
  list-style: none;
}
.tags li {
  padding: 0.25rem 0.55rem;
  border-radius: 99px;
  background: #e3eee5;
}
.blockers,
.stale {
  border-color: #e0ae67;
  background: #fff9ee;
}
.current {
  border-color: #69a57e;
  background: #eff9f1;
}
.confirm {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-weight: 700;
}
.error {
  color: #991b1b;
}
.warning {
  color: #7c4a03;
}
@media (max-width: 56rem) {
  .preview-grid,
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
