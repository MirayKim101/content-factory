<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";

import { createCreatorContextApi } from "~/shared/api/creator-context";
import { createThumbnailSuggestionsApi, ThumbnailSuggestionApiError, type ThumbnailSuggestion, type ThumbnailSuggestionApply } from "~/shared/api/thumbnail-suggestions";

const props = defineProps<{ projectId: string; jobId: string; expectedRevision: number }>();
const emit = defineEmits<{ applied: [value: ThumbnailSuggestionApply] }>();
const config = useRuntimeConfig();
const api = createThumbnailSuggestionsApi(config.public.apiBasePath);
const contextApi = createCreatorContextApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const selectedId = ref(""); const message = ref(""); const errorMessage = ref("");
const createAttempt = ref<{ fingerprint: string; key: string }>(); const applyAttempt = ref<{ fingerprint: string; key: string }>();

const prompt = useQuery({ queryKey: computed(() => ["thumbnail-prompt", props.jobId]), queryFn: () => contextApi.getCutPrompt(props.jobId), retry: false });
const suggestions = useQuery({ queryKey: computed(() => ["thumbnail-suggestions", props.projectId, props.jobId]), queryFn: () => api.list(props.projectId, props.jobId), retry: false, refetchOnMount: "always" });
watch(() => suggestions.data.value, (items) => { if (!selectedId.value && items?.[0]) selectedId.value = items[0].id; }, { immediate: true });
const detail = useQuery({ queryKey: computed(() => ["thumbnail-suggestion", selectedId.value]), queryFn: () => api.detail(props.projectId, props.jobId, selectedId.value), enabled: computed(() => Boolean(selectedId.value)), retry: false,
  refetchInterval: (state) => { const value = state.state.data as ThumbnailSuggestion | undefined; return value?.state === "QUEUED" || value?.state === "PROCESSING" ? 1000 : false; } });
const active = computed(() => detail.data.value ?? suggestions.data.value?.find((item) => item.id === selectedId.value));
const disabled = computed(() => suggestions.error.value instanceof ThumbnailSuggestionApiError && suggestions.error.value.status === 503);

const create = useMutation({ mutationFn: (request: { key: string; sourceContextRevisionId: string; cutPromptRevisionId: string }) => api.create(props.projectId, props.jobId, request.key, request),
  onSuccess: async (value) => { selectedId.value = value.id; errorMessage.value = ""; message.value = "Задача обложки сохранена. Ожидаем AI-worker."; await queryClient.invalidateQueries({ queryKey: ["thumbnail-suggestions", props.projectId, props.jobId] }); },
  onError: () => { errorMessage.value = "Не удалось создать вариант. Ручная обложка остаётся доступна."; } });
function requestCreate() {
  const value = prompt.data.value; if (!value || value.revision.status !== "CURRENT") return;
  const fingerprint = JSON.stringify([props.jobId, value.revision.sourceContextRevisionId, value.revision.id]);
  if (createAttempt.value?.fingerprint !== fingerprint) createAttempt.value = { fingerprint, key: crypto.randomUUID() };
  create.mutate({ key: createAttempt.value.key, sourceContextRevisionId: value.revision.sourceContextRevisionId, cutPromptRevisionId: value.revision.id });
}
const apply = useMutation({ mutationFn: (request: { intentId: string; key: string; revision: number }) => api.apply(props.projectId, props.jobId, request.intentId, request.key, request.revision),
  onSuccess: (value) => { applyAttempt.value = undefined; errorMessage.value = ""; message.value = `Обложка применена в revision ${value.revision}.`; emit("applied", value); },
  onError: () => { errorMessage.value = "Revision или image lineage устарели. Текущая обложка не изменена."; } });
function requestApply() {
  if (!active.value?.candidate || props.expectedRevision < 1) return;
  const fingerprint = JSON.stringify([active.value.id, props.expectedRevision]);
  if (applyAttempt.value?.fingerprint !== fingerprint) applyAttempt.value = { fingerprint, key: crypto.randomUUID() };
  apply.mutate({ intentId: active.value.id, key: applyAttempt.value.key, revision: props.expectedRevision });
}
</script>

<template>
  <section class="thumbnail-ai" aria-labelledby="thumbnail-ai-title">
    <h3 id="thumbnail-ai-title">Вариант обложки без likeness</h3>
    <p v-if="disabled" class="hint">AI-обложки выключены feature flag. Ручная загрузка доступна ниже.</p>
    <p v-else-if="prompt.isError.value" class="hint">Сначала сохраните current контекст и prompt. Ручная загрузка доступна ниже.</p>
    <template v-else>
      <Button type="button" :label="create.isPending.value ? 'Ставим в очередь…' : 'Создать безопасный вариант'" :disabled="create.isPending.value || prompt.data.value?.revision.status !== 'CURRENT'" @click="requestCreate" />
      <label v-if="suggestions.data.value?.length">Сохранённые варианты<select v-model="selectedId"><option v-for="item in suggestions.data.value" :key="item.id" :value="item.id">{{ item.state }} · {{ item.createdAt }}</option></select></label>
      <article v-if="active" class="candidate">
        <p>Статус: <strong>{{ active.state }}</strong> · likeness: <strong>{{ active.candidate?.likeness ?? '—' }}</strong></p>
        <p v-if="active.failure" class="error">{{ active.failure.message }}</p>
        <img v-if="active.candidate" :src="api.contentUrl(projectId, jobId, active.id, active.candidate.id)" alt="Сгенерированный абстрактный вариант обложки без реалистичного лица" />
        <Button v-if="active.candidate" type="button" :label="apply.isPending.value ? 'Применяем…' : 'Применить точный вариант'" :disabled="expectedRevision < 1 || apply.isPending.value" @click="requestApply" />
        <p v-if="expectedRevision < 1" class="hint">Сначала сохраните первый ручной черновик.</p>
      </article>
    </template>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p><p v-if="message" class="success" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.thumbnail-ai,.candidate,label{display:grid;gap:.65rem}.thumbnail-ai{padding:.875rem;border:1px solid #c4cec7;border-radius:.5rem;background:#f4f7f4}h3,p{margin:0}.candidate{padding:.75rem;background:#fff}.candidate img{width:100%;border-radius:.4rem}.hint{color:#4b5d51;font-size:.875rem}.error{color:#991b1b}.success{color:#166534}select{width:100%}
</style>
