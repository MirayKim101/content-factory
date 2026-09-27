<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import { computed, reactive, ref, watch } from "vue";

import {
  createResearchTextApi,
  ResearchApiError,
  type ResearchCitationInput,
  type ResearchMetadataApplyResponse,
  type ResearchSuggestionResponse,
} from "~/shared/api/research-text";

const props = defineProps<{
  jobId: string;
  expectedRevision: number;
  title: string;
  description: string;
  tagsText: string;
}>();
const emit = defineEmits<{
  loadSuggestion: [
    value: { title: string; description: string; tags: string[] },
  ];
  applied: [value: ResearchMetadataApplyResponse];
}>();
const config = useRuntimeConfig();
const api = createResearchTextApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const query = ref("");
const citations = reactive<ResearchCitationInput[]>([emptyCitation()]);
const selectedIntentId = ref("");
const message = ref("");
const errorMessage = ref("");
const createAttempt = ref<{ fingerprint: string; key: string }>();
const applyAttempt = ref<{ fingerprint: string; key: string }>();

function emptyCitation(): ResearchCitationInput {
  return { url: "", title: "", publisher: "", publishedAt: null, excerpt: "" };
}

const transcript = useQuery({
  queryKey: computed(() => ["latest-transcript", props.jobId]),
  queryFn: () => api.latestTranscriptForJob(props.jobId),
  retry: false,
  refetchOnMount: "always",
});
const suggestions = useQuery({
  queryKey: computed(() => ["research-suggestions", transcript.data.value?.id]),
  queryFn: () => api.list(transcript.data.value!.id),
  enabled: computed(() => transcript.data.value?.state === "READY"),
  retry: false,
  refetchOnMount: "always",
});
watch(
  () => suggestions.data.value,
  (items) => {
    if (!selectedIntentId.value && items?.[0])
      selectedIntentId.value = items[0].id;
  },
  { immediate: true },
);
const detail = useQuery({
  queryKey: computed(() => ["research-suggestion", selectedIntentId.value]),
  queryFn: () => api.detail(selectedIntentId.value),
  enabled: computed(() => Boolean(selectedIntentId.value)),
  retry: false,
  refetchInterval: (state) => {
    const value = state.state.data as ResearchSuggestionResponse | undefined;
    return value?.state === "QUEUED" || value?.state === "PROCESSING"
      ? 1_000
      : false;
  },
});
const active = computed(
  () =>
    detail.data.value ??
    suggestions.data.value?.find((item) => item.id === selectedIntentId.value),
);
const transcriptUnavailable = computed(() => {
  const error = transcript.error.value;
  if (error instanceof ResearchApiError && error.status === 404)
    return "Для этого результата ещё нет transcript evidence. Ручной редактор доступен ниже.";
  return error
    ? "Не удалось получить transcript evidence. Ручной редактор доступен ниже."
    : undefined;
});
const researchDisabled = computed(
  () =>
    suggestions.error.value instanceof ResearchApiError &&
    suggestions.error.value.status === 503,
);
const citationInputValid = computed(() =>
  citations.every(
    (item) =>
      item.url.startsWith("https://") &&
      Boolean(item.title.trim()) &&
      Boolean(item.publisher.trim()) &&
      Boolean(item.excerpt.trim()),
  ),
);

function createFingerprint(): string {
  return JSON.stringify({
    transcriptIntentId: transcript.data.value?.id,
    query: query.value.trim(),
    citations,
  });
}

const createSuggestion = useMutation({
  mutationFn: (request: {
    transcriptIntentId: string;
    idempotencyKey: string;
    query: string;
    citations: ResearchCitationInput[];
  }) =>
    api.create(request.transcriptIntentId, request.idempotencyKey, {
      query: request.query,
      citations: request.citations,
    }),
  onSuccess: async (value) => {
    selectedIntentId.value = value.id;
    message.value = "Research-задача сохранена. Ожидаем результат worker.";
    errorMessage.value = "";
    await queryClient.invalidateQueries({
      queryKey: ["research-suggestions", value.transcriptIntentId],
    });
    await queryClient.invalidateQueries({
      queryKey: ["research-suggestion", value.id],
    });
  },
  onError: (error) => {
    errorMessage.value =
      error instanceof ResearchApiError && error.status === 409
        ? "Контекст изменился или ключ операции уже занят. Обновите transcript и повторите."
        : "Не удалось создать research-задачу. Ручное редактирование остаётся доступно.";
  },
});

function requestCreate(): void {
  if (
    createSuggestion.isPending.value ||
    transcript.data.value?.state !== "READY" ||
    !query.value.trim() ||
    !citationInputValid.value
  )
    return;
  const fingerprint = createFingerprint();
  if (createAttempt.value?.fingerprint !== fingerprint)
    createAttempt.value = { fingerprint, key: crypto.randomUUID() };
  createSuggestion.mutate({
    transcriptIntentId: transcript.data.value.id,
    idempotencyKey: createAttempt.value.key,
    query: query.value.trim(),
    citations: citations.map((item) => ({
      ...item,
      publishedAt: item.publishedAt || null,
    })),
  });
}

function loadSuggestion(): void {
  const suggestion = active.value?.suggestion;
  if (!suggestion) return;
  emit("loadSuggestion", suggestion);
  message.value =
    "Вариант перенесён в поля ниже. Проверьте и отредактируйте его перед применением.";
}

const applyMetadata = useMutation({
  mutationFn: (request: {
    researchIntentId: string;
    idempotencyKey: string;
    expectedEditorialRevision: number;
    title: string;
    description: string;
    tags: string[];
  }) =>
    api.applyMetadata(request.researchIntentId, request.idempotencyKey, {
      expectedEditorialRevision: request.expectedEditorialRevision,
      title: request.title,
      description: request.description,
      tags: request.tags,
    }),
  onSuccess: (value) => {
    applyAttempt.value = undefined;
    errorMessage.value = "";
    message.value = `Создана revision ${value.revision}; provenance: ${value.metadataMode}.`;
    emit("applied", value);
  },
  onError: (error) => {
    errorMessage.value =
      error instanceof ResearchApiError && error.status === 409
        ? "Revision или research lineage устарели. Данные не применены; обновите сохранённую версию."
        : "Не удалось применить вариант. Текущий ручной ввод не потерян.";
  },
});

function requestApply(): void {
  if (!active.value?.suggestion || props.expectedRevision < 1) return;
  const input = {
    expectedEditorialRevision: props.expectedRevision,
    title: props.title.trim(),
    description: props.description.trim(),
    tags: props.tagsText
      .split("\n")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
  const fingerprint = JSON.stringify({
    researchIntentId: active.value.id,
    ...input,
  });
  if (applyAttempt.value?.fingerprint !== fingerprint)
    applyAttempt.value = { fingerprint, key: crypto.randomUUID() };
  applyMetadata.mutate({
    researchIntentId: active.value.id,
    idempotencyKey: applyAttempt.value.key,
    ...input,
  });
}
</script>

<template>
  <section class="research-panel" aria-labelledby="research-title">
    <header class="panel-header">
      <div>
        <p class="eyebrow">AI-помощник · с проверкой источников</p>
        <h3 id="research-title">Исследование и варианты текста</h3>
      </div>
      <span class="mode-badge">Ручное решение</span>
    </header>
    <p class="panel-summary">
      Добавьте проверяемые источники, получите черновик и перенесите его в
      редактор. Ничего не применяется без вашего действия.
    </p>
    <p v-if="transcript.isPending.value" role="status">
      Проверяем transcript evidence…
    </p>
    <p v-else-if="transcriptUnavailable" class="hint" role="status">
      {{ transcriptUnavailable }}
    </p>
    <p v-else-if="transcript.data.value?.state !== 'READY'" class="hint">
      Transcript имеет состояние {{ transcript.data.value?.state }}. Research
      станет доступен после READY; ручной редактор уже доступен.
    </p>
    <p v-else-if="researchDisabled" class="hint" role="status">
      Research отключён feature flag. Ручной редактор доступен ниже.
    </p>
    <template v-else-if="transcript.data.value?.state === 'READY'">
      <label class="field-stack">
        Что проверить и учесть
        <Textarea
          v-model="query"
          rows="3"
          maxlength="4000"
          aria-describedby="research-query-hint"
        />
        <small id="research-query-hint" class="hint">
          Сформулируйте факты, которые нужно подтвердить перед публикацией.
        </small>
      </label>
      <fieldset v-for="(citation, index) in citations" :key="index">
        <legend>Источник {{ index + 1 }}</legend>
        <label :for="`research-source-${index}-url`">
          Ссылка
          <InputText
            :id="`research-source-${index}-url`"
            v-model="citation.url"
            inputmode="url"
            placeholder="https://…"
          />
        </label>
        <label :for="`research-source-${index}-title`">
          Название материала
          <InputText
            :id="`research-source-${index}-title`"
            v-model="citation.title"
          />
        </label>
        <label :for="`research-source-${index}-publisher`">
          Издатель
          <InputText
            :id="`research-source-${index}-publisher`"
            v-model="citation.publisher"
          />
        </label>
        <label :for="`research-source-${index}-published-at`">
          Дата публикации источника
          <InputText
            :id="`research-source-${index}-published-at`"
            v-model="citation.publishedAt"
            placeholder="2026-09-27T12:00:00Z · необязательно"
          />
        </label>
        <label :for="`research-source-${index}-excerpt`">
          Подтверждаемый факт или выдержка
          <Textarea
            :id="`research-source-${index}-excerpt`"
            v-model="citation.excerpt"
            rows="2"
          />
        </label>
        <Button
          v-if="citations.length > 1"
          type="button"
          label="Удалить источник"
          severity="secondary"
          text
          @click="citations.splice(index, 1)"
        />
      </fieldset>
      <div class="research-actions">
        <Button
          type="button"
          label="Добавить источник"
          severity="secondary"
          @click="citations.push(emptyCitation())"
        />
        <Button
          type="button"
          :label="
            createSuggestion.isPending.value
              ? 'Ставим в очередь…'
              : 'Создать вариант'
          "
          :disabled="
            !query.trim() ||
            !citationInputValid ||
            createSuggestion.isPending.value
          "
          @click="requestCreate"
        />
      </div>
      <label v-if="suggestions.data.value?.length">
        Сохранённые варианты
        <select v-model="selectedIntentId">
          <option
            v-for="item in suggestions.data.value"
            :key="item.id"
            :value="item.id"
          >
            {{ item.state }} · {{ item.snapshot.query }}
          </option>
        </select>
      </label>
      <article v-if="active" class="research-result" aria-live="polite">
        <p>
          Статус: <strong>{{ active.state }}</strong> · свежесть:
          <strong>{{ active.snapshot.freshness }}</strong>
        </p>
        <p v-if="active.failure" class="error">{{ active.failure.message }}</p>
        <template v-if="active.suggestion">
          <p>
            <strong>{{ active.suggestion.title }}</strong>
          </p>
          <p>{{ active.suggestion.description }}</p>
          <p>Теги: {{ active.suggestion.tags.join(", ") }}</p>
          <ul>
            <li
              v-for="citation in active.snapshot.citations"
              :key="citation.id"
            >
              <a :href="citation.url" target="_blank" rel="noopener noreferrer">
                {{ citation.title }} — {{ citation.publisher }}
              </a>
            </li>
          </ul>
          <div class="research-actions">
            <Button
              type="button"
              label="Перенести в поля"
              severity="secondary"
              @click="loadSuggestion"
            />
            <Button
              type="button"
              :label="
                applyMetadata.isPending.value
                  ? 'Применяем…'
                  : 'Применить текущие поля'
              "
              :disabled="expectedRevision < 1 || applyMetadata.isPending.value"
              @click="requestApply"
            />
          </div>
          <p v-if="expectedRevision < 1" class="hint">
            Сначала сохраните первый ручной черновик; затем research создаст
            следующую immutable revision и сохранит текущую обложку.
          </p>
        </template>
      </article>
    </template>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-if="message" class="success" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.research-panel,
.research-panel fieldset,
.research-result {
  display: grid;
  gap: 0.65rem;
}
.research-panel {
  padding: 1rem;
  border: 1px solid var(--cf-border);
  border-radius: 0.75rem;
  background: var(--cf-surface-subtle);
}
h3,
p {
  margin: 0;
}
label {
  display: grid;
  gap: 0.4rem;
}
.panel-header,
.research-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.panel-header > div,
.field-stack {
  display: grid;
  gap: 0.35rem;
}
.eyebrow {
  color: var(--cf-brand);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.mode-badge {
  padding: 0.3rem 0.55rem;
  border-radius: 999px;
  background: var(--cf-brand-soft);
  color: var(--cf-brand-strong);
  font-size: 0.75rem;
  font-weight: 700;
}
.panel-summary {
  max-width: 72ch;
  color: var(--cf-text-muted);
  line-height: 1.5;
}
input,
textarea,
select {
  box-sizing: border-box;
  width: 100%;
}
.research-result {
  padding: 0.75rem;
  border: 1px solid var(--cf-border);
  border-radius: 0.5rem;
  background: var(--cf-surface);
}
.hint {
  color: var(--cf-text-muted);
  font-size: 0.875rem;
}
.error {
  color: var(--cf-danger);
}
.success {
  color: var(--cf-success);
}
</style>
