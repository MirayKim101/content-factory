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
const thumbnailPreviewFailed = ref(false);
const videoPreviewFailed = ref(false);
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
    !thumbnailPreviewFailed.value &&
    !videoPreviewFailed.value &&
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
  thumbnailPreviewFailed.value = false;
  videoPreviewFailed.value = false;
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
function staleReasonLabel(value: string): string {
  return (
    {
      EDITORIAL_REVISION_CHANGED: "изменилось оформление",
      RECIPE_REVISION_CHANGED: "изменился монтаж",
      RENDER_CHANGED: "создана новая сборка",
      LINEAGE_INVALID: "нарушена целостность версии",
    }[value] ?? "версия больше не актуальна"
  );
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
    thumbnailPreviewFailed.value = false;
    videoPreviewFailed.value = false;
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
    :style="{ width: 'min(78rem, calc(100vw - 1.5rem))' }"
    :pt="{
      root: { class: 'review-dialog-root' },
      mask: { class: 'review-dialog-mask' },
      header: { class: 'review-dialog-header' },
      title: { class: 'review-dialog-title' },
      closeButton: { class: 'review-dialog-close' },
      content: { class: 'review-dialog-content' },
    }"
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
        <header class="review-overview">
          <div>
            <p class="review-eyebrow">Финальная проверка</p>
            <h2>{{ candidate.editorial?.title ?? "Редакционный пакет" }}</h2>
            <p>
              Revision {{ candidate.editorial?.revision ?? "—" }} · сборка
              {{ candidate.recipe?.revision ?? "—" }} · после подтверждения
              будет зафиксирована именно эта версия.
            </p>
          </div>
          <span class="mode-badge" :data-mode="candidate.workflowMode">
            {{ modeLabel(candidate.workflowMode) }}
          </span>
        </header>
        <ol class="review-steps" aria-label="Этапы проверки">
          <li class="active"><span>1</span>Контент</li>
          <li><span>2</span>Происхождение</li>
          <li><span>3</span>Подтверждение</li>
        </ol>
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
            Ранее подтверждённая версия больше не действует. Проверьте текущую
            revision и подтвердите её заново.
          </p>
          <ul v-if="!candidate.currentApproval" class="stale-reasons">
            <li
              v-for="reason in candidate.latestApproval?.staleReasons ?? []"
              :key="reason"
            >
              {{ staleReasonLabel(reason) }}
            </li>
          </ul>
        </section>
        <template
          v-if="candidate.editorial && candidate.recipe && candidate.render"
        >
          <div class="preview-grid">
            <section class="preview-card">
              <div class="section-title-row">
                <div>
                  <span class="section-index">01</span>
                  <h3>Готовое видео</h3>
                </div>
                <span>Обязательная проверка</span>
              </div>
              <div class="media-frame">
                <video
                  class="review-video"
                  controls
                  preload="metadata"
                  :src="candidate.render.contentUrl"
                  aria-label="Предпросмотр готового горизонтального видео"
                  @loadeddata="videoPreviewFailed = false"
                  @error="videoPreviewFailed = true"
                />
                <p v-if="videoPreviewFailed" class="preview-error" role="alert">
                  Видео не загрузилось. Подтверждение заблокировано — обновите
                  проверку или повторите позже.
                </p>
              </div>
              <dl class="facts">
                <dt>Длительность</dt>
                <dd>{{ formatDuration(candidate.render.durationMs) }}</dd>
                <dt>Размер</dt>
                <dd>{{ formatBytes(candidate.render.artifactSizeBytes) }}</dd>
              </dl>
            </section>
            <section class="preview-card">
              <div class="section-title-row">
                <div>
                  <span class="section-index">02</span>
                  <h3>Обложка</h3>
                </div>
                <span>16:9</span>
              </div>
              <div class="media-frame thumbnail-frame">
                <img
                  v-show="!thumbnailPreviewFailed"
                  class="thumbnail"
                  :src="candidate.editorial.thumbnail.contentUrl"
                  :alt="`Обложка: ${candidate.editorial.thumbnail.filename}`"
                  @load="thumbnailPreviewFailed = false"
                  @error="thumbnailPreviewFailed = true"
                />
                <p
                  v-if="thumbnailPreviewFailed"
                  class="preview-error"
                  role="alert"
                >
                  Обложка не загрузилась. Подтверждение заблокировано — файл
                  должен быть виден перед финальным решением.
                </p>
              </div>
              <p class="asset-caption">
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
          <details class="technical-details">
            <summary>
              <span>Происхождение и стоимость</span>
              <small>Режимы компонентов, citations и AI cost</small>
            </summary>
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
          </details>
          <section class="revision">
            <span class="revision-label">Точная версия</span>
            <p>
              Metadata revision {{ candidate.editorial.revision }} · рецепт
              revision {{ candidate.recipe.revision }} · render contract
              {{ candidate.render.renderContractVersion }}
            </p>
          </section>
        </template>
        <details v-if="candidate.processingMetrics" class="technical-details">
          <summary>
            <span>Показатели обработки</span>
            <small>Очередь, активная работа и повторные попытки</small>
          </summary>
        <section class="metrics">
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
        </details>
        <section v-else class="warning">
          <strong>Показатели обработки пока недоступны.</strong> Подтверждение
          безопасно заблокировано, пока сервер не вернёт полный набор данных.
        </section>
        <section v-if="!isCurrent" class="approval-action">
          <div class="approval-copy">
            <span class="section-index">03</span>
            <div>
              <h3>Подтвердите точную версию</h3>
              <p>
                Убедитесь, что видео, обложка и metadata выше готовы к ручной
                публикации. Любое последующее изменение отменит подтверждение.
              </p>
            </div>
          </div>
          <div class="attention-row" aria-label="Время проверки">
            <span>Подготовка <strong>{{ formatDuration(displayedAttention("PREPARATION")) }}</strong></span>
            <span>Финальная проверка <strong>{{ formatDuration(displayedAttention("FINAL_REVIEW")) }}</strong></span>
            <small>Счётчики работают только в активной вкладке</small>
          </div>
          <p v-if="idempotencyKey" class="warning" role="status">
            Предыдущий запрос ожидает безопасного повтора. Время проверки
            зафиксировано; повтор будет отправлен с теми же параметрами.
          </p>
          <label class="confirm">
            <Checkbox v-model="checked" binary input-id="editorial-approve" />
            <span>
              <strong>Проверил и подтверждаю эту версию</strong>
              <small>Видео воспроизводится, обложка видна, текст и теги корректны.</small>
            </span>
          </label>
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
  gap: 0.9rem;
  padding: 0 1.1rem 1.1rem;
  background: var(--cf-bg);
}
.review-overview {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  padding-top: 1rem;
}
.review-overview h2 {
  margin: 0.15rem 0 0.25rem;
  font-size: 1.35rem;
  line-height: 1.25;
  letter-spacing: -0.02em;
}
.review-overview p {
  margin: 0;
  color: var(--cf-text-muted);
}
.review-eyebrow {
  color: var(--cf-brand) !important;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.mode-badge {
  flex: 0 0 auto;
  padding: 0.35rem 0.65rem;
  border-radius: 999px;
  background: var(--cf-info-soft);
  color: var(--cf-info);
  font-size: 0.75rem;
  font-weight: 750;
}
.mode-badge[data-mode="MANUAL"] {
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
}
.mode-badge[data-mode="AI_ASSISTED"] {
  background: #eeeafd;
  color: #6248a8;
}
.review-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: #fff;
  list-style: none;
}
.review-steps li {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.65rem 0.8rem;
  border-right: 1px solid var(--cf-border);
  color: var(--cf-text-muted);
  font-size: 0.8rem;
  font-weight: 680;
}
.review-steps li:last-child {
  border-right: 0;
}
.review-steps span,
.section-index {
  display: grid;
  flex: 0 0 1.65rem;
  width: 1.65rem;
  height: 1.65rem;
  place-items: center;
  border-radius: 50%;
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
  font-size: 0.7rem;
  font-weight: 800;
}
.review-steps .active {
  color: var(--cf-brand-strong);
}
.review-steps .active span,
.section-index {
  background: var(--cf-brand);
  color: #fff;
}
.preview-grid,
.metric-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
  gap: 0.8rem;
}
.preview-card {
  min-width: 0;
  padding: 0.8rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: #fff;
}
.section-title-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.65rem;
}
.section-title-row > div {
  display: flex;
  gap: 0.55rem;
  align-items: center;
}
.section-title-row h3 {
  margin: 0;
  font-size: 0.95rem;
}
.section-title-row > span {
  color: var(--cf-text-muted);
  font-size: 0.68rem;
  font-weight: 650;
}
.media-frame {
  position: relative;
  display: grid;
  min-height: 9rem;
  place-items: center;
  overflow: hidden;
  border-radius: 0.65rem;
  background: #101615;
}
.thumbnail-frame {
  aspect-ratio: 16 / 9;
}
.review-video,
.thumbnail {
  display: block;
  width: 100%;
  max-height: 25rem;
  object-fit: contain;
  background: #101615;
}
.thumbnail {
  aspect-ratio: 16 / 9;
  object-fit: cover;
}
.preview-error {
  max-width: 26rem;
  margin: 0;
  padding: 1rem;
  color: #ffd8d4;
  text-align: center;
}
.asset-caption {
  margin: 0.55rem 0 0;
  color: var(--cf-text-muted);
  font-size: 0.76rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
  margin: 0.55rem 0 0;
  font-size: 0.76rem;
}
.facts dt {
  color: var(--cf-text-muted);
}
.facts dd {
  margin: 0;
  font-weight: 700;
}
.metadata,
.revision,
.approval-action,
.export-next,
.blockers,
.approval-state {
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  padding: 0.85rem;
  background: #fff;
}
.metadata h3 {
  margin: 0 0 0.3rem;
  font-size: 1rem;
}
.metadata .description {
  margin: 0;
  color: var(--cf-text-muted);
}
.description {
  white-space: pre-wrap;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0;
  padding: 0;
  list-style: none;
}
.tags li {
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: var(--cf-brand-soft);
  color: var(--cf-brand-strong);
  font-size: 0.75rem;
}
.blockers,
.stale {
  border-color: #efc171;
  background: var(--cf-warning-soft);
  color: var(--cf-warning);
}
.current {
  border-color: #81bd98;
  background: var(--cf-success-soft);
  color: var(--cf-success);
}
.approval-state p {
  margin: 0.25rem 0 0;
}
.stale-reasons {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
}
.stale-reasons li {
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: rgb(139 82 12 / 0.1);
  font-size: 0.72rem;
  font-weight: 700;
}
.technical-details {
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-md);
  background: #fff;
}
.technical-details > summary {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 0.9rem;
  cursor: pointer;
  list-style: none;
}
.technical-details > summary::-webkit-details-marker {
  display: none;
}
.technical-details > summary::after {
  content: "+";
  display: grid;
  flex: 0 0 1.6rem;
  width: 1.6rem;
  height: 1.6rem;
  place-items: center;
  border-radius: 50%;
  background: var(--cf-surface-muted);
  color: var(--cf-text-muted);
}
.technical-details[open] > summary::after {
  content: "−";
}
.technical-details > summary span {
  font-weight: 720;
}
.technical-details > summary small {
  margin-left: auto;
  color: var(--cf-text-muted);
  font-size: 0.72rem;
}
.component-review,
.metrics {
  padding: 0 0.9rem 0.9rem;
  border-top: 1px solid var(--cf-border);
}
.component-review h3,
.metrics h3 {
  margin-top: 0.85rem;
}
.revision {
  display: flex;
  gap: 0.7rem;
  align-items: center;
  color: var(--cf-text-muted);
  font-size: 0.76rem;
}
.revision p {
  margin: 0;
}
.revision-label {
  flex: 0 0 auto;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: var(--cf-surface-muted);
  color: var(--cf-text);
  font-weight: 700;
}
.approval-action,
.export-next {
  position: sticky;
  bottom: -1px;
  z-index: 3;
  display: grid;
  gap: 0.75rem;
  border-color: #a8cdbd;
  border-radius: var(--cf-radius-lg);
  background: rgb(255 255 255 / 0.98);
  box-shadow: 0 -12px 32px rgb(15 34 40 / 0.1);
  backdrop-filter: blur(14px);
}
.approval-copy {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
}
.approval-copy h3,
.approval-copy p {
  margin: 0;
}
.approval-copy p {
  margin-top: 0.2rem;
  color: var(--cf-text-muted);
  font-size: 0.8rem;
}
.attention-row {
  display: flex;
  gap: 0.5rem 1rem;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.6rem 0.7rem;
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-subtle);
  color: var(--cf-text-muted);
  font-size: 0.73rem;
}
.attention-row strong {
  margin-left: 0.2rem;
  color: var(--cf-text);
  font-variant-numeric: tabular-nums;
}
.attention-row small {
  margin-left: auto;
}
.confirm {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  padding: 0.7rem;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface-subtle);
  cursor: pointer;
}
.confirm > span {
  display: grid;
}
.confirm strong {
  font-size: 0.84rem;
}
.confirm small {
  color: var(--cf-text-muted);
  font-size: 0.72rem;
}
.error {
  color: var(--cf-danger);
}
.warning {
  color: var(--cf-warning);
}
@media (max-width: 56rem) {
  .preview-grid,
  .metric-grid {
    grid-template-columns: 1fr;
  }
  .review-overview {
    flex-direction: column;
  }
  .technical-details > summary small {
    display: none;
  }
  .attention-row small {
    width: 100%;
    margin-left: 0;
  }
}
@media (max-width: 34rem) {
  .review-dialog {
    padding: 0 0.7rem 0.7rem;
  }
  .review-steps li {
    justify-content: center;
    padding: 0.55rem;
    font-size: 0.7rem;
  }
  .review-steps li > span {
    display: none;
  }
}
</style>

<style>
.review-dialog-root {
  position: relative;
  z-index: 1401;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 1.5rem);
  overflow: hidden;
  border: 1px solid var(--cf-border);
  border-radius: 1rem;
  background: var(--cf-bg);
  box-shadow: var(--cf-shadow-lg);
}
.review-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 1400 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem;
  background: rgb(9 20 18 / 0.56);
  backdrop-filter: blur(3px);
}
.review-dialog-header {
  display: flex;
  flex: 0 0 auto;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  min-height: 3.7rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--cf-border);
  background: #fff;
}
.review-dialog-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 730;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.review-dialog-close {
  display: grid;
  flex: 0 0 2.1rem;
  width: 2.1rem;
  height: 2.1rem;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: var(--cf-surface-muted);
  cursor: pointer;
}
.review-dialog-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0;
}
</style>
