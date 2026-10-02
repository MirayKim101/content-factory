<script setup lang="ts">
import { useMutation, useQuery } from "@tanstack/vue-query";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Textarea from "primevue/textarea";
import { computed, ref } from "vue";

import {
  ClipTranscriptFormatError,
  parseClipTranscript,
} from "~/features/clip-generation/model/parse-transcript";
import {
  createClipGenerationApi,
  ClipGenerationApiError,
} from "~/shared/api/clip-generation";
import { formatDisplayTimecode } from "~/shared/lib/timecode";

const props = defineProps<{
  projectId: string;
  sourceTitle: string;
  sourceDurationMs: number;
}>();
const emit = defineEmits<{
  seek: [milliseconds: number];
  accepted: [jobIds: string[]];
}>();
const config = useRuntimeConfig();
const api = createClipGenerationApi(config.public.apiBasePath);
const selected = ref<string[]>([]);
const transcriptText = ref("");
const transferAllowed = ref(false);
let retryIdentity: { fingerprint: string; key: string } | undefined;
let generationIdentity: { fingerprint: string; key: string } | undefined;

const query = useQuery({
  queryKey: computed(() => ["clip-generations", props.projectId]),
  queryFn: () => api.list(props.projectId),
  refetchInterval: (state) =>
    state.state.data?.items.some(
      (item) => item.state === "QUEUED" || item.state === "PROCESSING",
    )
      ? 2_000
      : false,
  retry: false,
});
const latest = computed(() => query.data.value?.items[0]);
const unavailable = computed(
  () =>
    query.error.value instanceof ClipGenerationApiError &&
    query.error.value.code === "CLIP_GENERATION_DISABLED" &&
    query.error.value.status === 503,
);
const readyIds = computed(
  () => new Set(latest.value?.suggestions.map((item) => item.id) ?? []),
);
const validSelection = computed(() =>
  selected.value.filter((id) => readyIds.value.has(id)),
);
const parsedTranscript = computed(() => {
  try {
    return {
      cues: parseClipTranscript(transcriptText.value, props.sourceDurationMs),
      error: undefined,
    };
  } catch (error) {
    return {
      cues: [],
      error:
        error instanceof ClipTranscriptFormatError
          ? error.message
          : "Не удалось проверить транскрипт.",
    };
  }
});
const generationActive = computed(
  () =>
    latest.value?.state === "QUEUED" || latest.value?.state === "PROCESSING",
);
const create = useMutation({
  mutationFn: async () => {
    const fingerprint = JSON.stringify([
      props.projectId,
      props.sourceTitle,
      transcriptText.value,
      transferAllowed.value,
    ]);
    const key =
      generationIdentity?.fingerprint === fingerprint
        ? generationIdentity.key
        : `clip-create-${crypto.randomUUID()}`;
    generationIdentity = { fingerprint, key };
    return api.create({
      projectId: props.projectId,
      idempotencyKey: key,
      sourceTitle: props.sourceTitle,
      transcript: parsedTranscript.value.cues,
      maximumSuggestions: 5,
      minimumClipDurationMs: 15_000,
      maximumClipDurationMs: 60_000,
      language: "ru",
      externalProviderTransferAllowed: transferAllowed.value,
    });
  },
  onSuccess: async () => {
    generationIdentity = undefined;
    transferAllowed.value = false;
    await query.refetch();
  },
});
const canCreate = computed(
  () =>
    parsedTranscript.value.cues.length > 0 &&
    transferAllowed.value &&
    !generationActive.value &&
    !create.isPending.value,
);
const accept = useMutation({
  mutationFn: async () => {
    const fingerprint = JSON.stringify([
      latest.value?.id,
      [...validSelection.value].sort(),
    ]);
    const key =
      retryIdentity?.fingerprint === fingerprint
        ? retryIdentity.key
        : `clip-accept-${crypto.randomUUID()}`;
    retryIdentity = { fingerprint, key };
    return api.accept({
      intentId: latest.value!.id,
      suggestionIds: validSelection.value,
      idempotencyKey: key,
    });
  },
  onSuccess: (result) => {
    retryIdentity = undefined;
    selected.value = [];
    emit(
      "accepted",
      result.jobs.map((job) => job.id),
    );
  },
});

function toggleAll(): void {
  selected.value =
    validSelection.value.length === (latest.value?.suggestions.length ?? 0)
      ? []
      : (latest.value?.suggestions.map((item) => item.id) ?? []);
}
</script>

<template>
  <section
    v-if="!unavailable"
    class="ai-panel"
    aria-labelledby="ai-clips-title"
  >
    <div class="panel-heading">
      <div>
        <p class="panel-kicker">AI-помощник · решение принимает редактор</p>
        <h2 id="ai-clips-title">Рекомендованные моменты</h2>
      </div>
      <Button
        type="button"
        severity="secondary"
        :loading="query.isFetching.value"
        @click="query.refetch()"
        >Обновить</Button
      >
    </div>
    <p v-if="query.isLoading.value" role="status">Проверяем рекомендации…</p>
    <div v-else-if="query.isError.value" class="inline-error" role="alert">
      Не удалось получить рекомендации.
      <button type="button" @click="query.refetch()">Повторить</button>
    </div>
    <div v-else class="generation-form">
      <div>
        <strong>Новый анализ</strong>
        <p>
          Вставьте SRT или WebVTT с точными таймкодами. Ручная нарезка ниже
          продолжает работать независимо.
        </p>
      </div>
      <label for="clip-transcript">Транскрипт с таймкодами</label>
      <Textarea
        id="clip-transcript"
        v-model="transcriptText"
        rows="7"
        placeholder="00:00:05,000 --> 00:00:12,000&#10;Текст фрагмента"
        :disabled="generationActive || create.isPending.value"
      />
      <p
        v-if="transcriptText && parsedTranscript.error"
        class="inline-error"
        role="alert"
      >
        {{ parsedTranscript.error }}
      </p>
      <p v-else-if="parsedTranscript.cues.length" class="validation-ok">
        Распознано cue: {{ parsedTranscript.cues.length }}
      </p>
      <label class="consent-row" for="clip-transfer-consent">
        <Checkbox
          v-model="transferAllowed"
          input-id="clip-transfer-consent"
          binary
          :disabled="generationActive || create.isPending.value"
        />
        <span
          >Разрешаю передать этот транскрипт настроенному внешнему AI-provider
          для поиска моментов.</span
        >
      </label>
      <div class="generation-actions">
        <span v-if="generationActive">Текущий анализ уже выполняется.</span>
        <Button
          type="button"
          :disabled="!canCreate"
          :loading="create.isPending.value"
          @click="create.mutate()"
          >Найти моменты</Button
        >
      </div>
      <p v-if="create.isError.value" class="inline-error" role="alert">
        {{ (create.error.value as Error).message }}
      </p>
    </div>
    <template v-if="latest">
      <div class="run-status">
        <span class="status-dot" :class="latest.state.toLowerCase()" />
        <strong>{{
          latest.state === "READY"
            ? "Рекомендации готовы"
            : latest.state === "FAILED_FINAL"
              ? "Генерация не завершена"
              : "AI анализирует транскрипт"
        }}</strong>
        <span>{{ latest.provider }} · {{ latest.model }}</span>
      </div>
      <p v-if="latest.failureMessage" class="inline-error">
        {{ latest.failureMessage }}
      </p>
      <div v-if="latest.state === 'READY'" class="suggestion-toolbar">
        <button type="button" class="text-action" @click="toggleAll">
          {{
            validSelection.length === latest.suggestions.length
              ? "Снять выбор"
              : "Выбрать все"
          }}
        </button>
        <span
          >Выбрано: {{ validSelection.length }} из
          {{ latest.suggestions.length }}</span
        >
      </div>
      <div class="suggestion-list">
        <article
          v-for="suggestion in latest.suggestions"
          :key="suggestion.id"
          class="suggestion-card"
          :class="{ selected: selected.includes(suggestion.id) }"
        >
          <Checkbox
            v-model="selected"
            :input-id="`suggestion-${suggestion.id}`"
            :value="suggestion.id"
          />
          <label :for="`suggestion-${suggestion.id}`" class="suggestion-copy">
            <strong>{{ suggestion.title }}</strong>
            <span
              >{{ formatDisplayTimecode(suggestion.startMs) }}–{{
                formatDisplayTimecode(suggestion.endMs)
              }}
              · {{ Math.round(suggestion.confidenceBasisPoints / 100) }}%</span
            >
            <small>{{ suggestion.rationale }}</small>
          </label>
          <Button
            type="button"
            severity="secondary"
            size="small"
            @click="emit('seek', suggestion.startMs)"
            >Посмотреть</Button
          >
        </article>
      </div>
      <div v-if="latest.state === 'READY'" class="panel-footer">
        <p>
          После запуска каждый выбранный момент станет обычным независимым cut
          job.
        </p>
        <Button
          type="button"
          :disabled="validSelection.length === 0 || accept.isPending.value"
          @click="accept.mutate()"
          >{{
            accept.isPending.value
              ? "Создаём задания…"
              : `Нарезать выбранное (${validSelection.length})`
          }}</Button
        >
      </div>
      <p v-if="accept.isError.value" class="inline-error" role="alert">
        {{ (accept.error.value as Error).message }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.ai-panel {
  margin-top: 1.5rem;
  padding: 1.25rem;
  border: 1px solid #c7d8ff;
  border-radius: 1rem;
  background: linear-gradient(135deg, #f7f9ff, #fff);
}
.panel-heading,
.run-status,
.suggestion-toolbar,
.panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.panel-heading h2 {
  margin: 0.2rem 0 0;
}
.panel-kicker {
  margin: 0;
  color: #3157a6;
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.run-status {
  justify-content: flex-start;
  margin: 1rem 0;
  color: var(--cf-text-muted);
}
.status-dot {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: #f59e0b;
}
.status-dot.ready {
  background: #10b981;
}
.status-dot.failed_final {
  background: #ef4444;
}
.suggestion-toolbar {
  padding: 0.75rem 0;
  border-top: 1px solid #dce5f7;
}
.text-action {
  border: 0;
  padding: 0;
  color: #3157a6;
  background: transparent;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.suggestion-list {
  display: grid;
  gap: 0.65rem;
}
.suggestion-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.85rem;
  padding: 0.9rem;
  border: 1px solid var(--cf-border);
  border-radius: 0.8rem;
  background: #fff;
}
.suggestion-card.selected {
  border-color: #6688db;
  box-shadow: 0 0 0 2px #dce6ff;
}
.suggestion-copy {
  display: grid;
  gap: 0.2rem;
  cursor: pointer;
}
.suggestion-copy span,
.suggestion-copy small {
  color: var(--cf-text-muted);
}
.panel-footer {
  margin-top: 1rem;
}
.panel-footer p {
  margin: 0;
}
.generation-form {
  display: grid;
  gap: 0.75rem;
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid var(--cf-border);
  border-radius: 0.85rem;
  background: #fff;
}
.generation-form p {
  margin: 0.25rem 0 0;
  color: var(--cf-text-muted);
}
.generation-form textarea {
  width: 100%;
  resize: vertical;
}
.consent-row {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  cursor: pointer;
}
.generation-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1rem;
}
.validation-ok {
  color: #087d5b !important;
  font-weight: 700;
}
.empty-state,
.inline-error {
  padding: 0.9rem;
  border-radius: 0.7rem;
  background: #fff;
}
.inline-error {
  color: #991b1b;
  background: #fff1f1;
}
@media (max-width: 640px) {
  .suggestion-card {
    grid-template-columns: auto 1fr;
  }
  .suggestion-card :deep(.p-button) {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
