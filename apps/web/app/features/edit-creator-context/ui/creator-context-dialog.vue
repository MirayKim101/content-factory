<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { computed, reactive, ref, watch } from "vue";
import {
  promptFormSchema,
  sourceContextFormSchema,
} from "~/features/edit-creator-context/model/forms";
import {
  clearCreatorOperationKey,
  creatorOperationKey,
} from "~/features/edit-creator-context/model/attempt-storage";
import {
  createCreatorContextApi,
  CreatorContextApiError,
  type CutPromptInput,
  type SourceContextInput,
} from "~/shared/api/creator-context";

const props = defineProps<{
  visible: boolean;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  jobId: string;
  filename: string;
}>();
const emit = defineEmits<{ "update:visible": [value: boolean] }>();
const config = useRuntimeConfig();
const api = createCreatorContextApi(config.public.apiBasePath);
const client = useQueryClient();
const enabled = computed(() => config.public.aiContextEnabled === true);
const identity = computed(
  () =>
    `${props.projectId}:${props.sourceId}:${props.sourceVersion}:${props.jobId}`,
);
const loaded = ref("");
const dirty = ref(false);
const error = ref<string>();
const success = ref<string>();
const sourceForm = reactive({
  creatorProfileId: "",
  creatorProfileRevision: 0,
  sourceTitle: "",
  gameOrTopic: "",
  audience: "",
  editorialGoal: "",
  language: "",
  defaultCta: "",
  restrictionsText: "",
  operatorNotes: "",
});
const promptForm = reactive({
  whatHappens: "",
  desiredAngle: "",
  tone: "",
  cta: "",
  restrictionsText: "",
});
const profiles = useQuery({
  queryKey: ["creator-profiles"],
  queryFn: api.listProfiles,
  enabled: computed(() => props.visible && enabled.value),
  retry: 1,
});
const context = useQuery({
  queryKey: computed(() => [
    "source-context",
    props.projectId,
    props.sourceId,
    props.sourceVersion,
  ]),
  queryFn: () =>
    api.getSourceContext(props.projectId, props.sourceId, props.sourceVersion),
  enabled: computed(() => props.visible && enabled.value),
  retry: false,
});
const prompt = useQuery({
  queryKey: computed(() => ["cut-prompt", props.jobId, props.sourceVersion]),
  queryFn: () => api.getCutPrompt(props.jobId),
  enabled: computed(() => props.visible && enabled.value),
  retry: false,
});
function load() {
  const c = context.data.value?.revision.editableRevision;
  sourceForm.creatorProfileId = c?.creatorProfileId ?? "";
  sourceForm.creatorProfileRevision = c?.creatorProfileRevision ?? 0;
  sourceForm.sourceTitle = c?.sourceTitle ?? props.filename;
  sourceForm.gameOrTopic = c?.gameOrTopic ?? "";
  sourceForm.audience = c?.audience ?? "";
  sourceForm.editorialGoal = c?.editorialGoal ?? "";
  sourceForm.language = c?.language ?? "";
  sourceForm.defaultCta = c?.defaultCta ?? "";
  sourceForm.restrictionsText = c?.restrictions.join("\n") ?? "";
  sourceForm.operatorNotes = c?.operatorNotes ?? "";
  const p = prompt.data.value?.revision.editableRevision;
  promptForm.whatHappens = p?.whatHappens ?? "";
  promptForm.desiredAngle = p?.desiredAngle ?? "";
  promptForm.tone = p?.tone ?? "";
  promptForm.cta = p?.cta ?? "";
  promptForm.restrictionsText = p?.restrictions.join("\n") ?? "";
  dirty.value = false;
  loaded.value = identity.value;
}
watch(
  [() => context.data.value, () => prompt.data.value, identity],
  () => {
    if (
      props.visible &&
      loaded.value !== identity.value &&
      !context.isFetching.value &&
      !prompt.isFetching.value
    )
      load();
  },
  { immediate: true },
);
watch(
  () => sourceForm.creatorProfileId,
  (id) => {
    const profile = profiles.data.value?.find((item) => item.id === id);
    if (profile && !context.data.value)
      sourceForm.creatorProfileRevision = profile.currentRevision;
    dirty.value = true;
  },
);
function sourcePayload():
  (SourceContextInput & { expectedRevision: number }) | undefined {
  const value = sourceContextFormSchema.safeParse(sourceForm);
  if (!value.success) {
    error.value = value.error.issues[0]?.message ?? "Проверьте source context.";
    return;
  }
  return {
    creatorProfileId: value.data.creatorProfileId,
    creatorProfileRevision: value.data.creatorProfileRevision,
    sourceTitle: value.data.sourceTitle,
    gameOrTopic: value.data.gameOrTopic,
    audience: value.data.audience,
    editorialGoal: value.data.editorialGoal,
    language: value.data.language,
    defaultCta: value.data.defaultCta,
    restrictions: value.data.restrictionsText,
    operatorNotes: value.data.operatorNotes,
    expectedRevision: context.data.value?.currentRevision ?? 0,
  };
}
function promptPayload():
  (CutPromptInput & { expectedRevision: number }) | undefined {
  const source = context.data.value;
  if (!source) {
    error.value = "Сначала сохраните exact source context.";
    return;
  }
  const value = promptFormSchema.safeParse(promptForm);
  if (!value.success) {
    error.value = value.error.issues[0]?.message ?? "Проверьте cut prompt.";
    return;
  }
  return {
    sourceContextId: source.id,
    sourceContextRevision: source.currentRevision,
    whatHappens: value.data.whatHappens,
    desiredAngle: value.data.desiredAngle,
    tone: value.data.tone,
    cta: value.data.cta,
    restrictions: value.data.restrictionsText,
    expectedRevision: prompt.data.value?.currentRevision ?? 0,
  };
}
const saveContext = useMutation({
  mutationFn: (body: NonNullable<ReturnType<typeof sourcePayload>>) =>
    api.saveSourceContext(
      props.projectId,
      props.sourceId,
      props.sourceVersion,
      body,
      creatorOperationKey("source-context", identity.value, body),
    ),
  onSuccess: (value) => {
    if (loaded.value !== identity.value) return;
    clearCreatorOperationKey("source-context", identity.value);
    client.setQueryData(
      ["source-context", props.projectId, props.sourceId, props.sourceVersion],
      value,
    );
    success.value = `Source context revision ${value.currentRevision} сохранён.`;
    dirty.value = false;
  },
  onError: (cause) => {
    const e = cause as CreatorContextApiError;
    error.value =
      e.status === 409
        ? "Контекст изменился на сервере. Загрузите server revision: overwrite запрещён."
        : e.code === "AI_CONTEXT_DISABLED"
          ? "Creator context отключён. Ручной поток не затронут."
          : e.message;
  },
});
const savePrompt = useMutation({
  mutationFn: (body: NonNullable<ReturnType<typeof promptPayload>>) =>
    api.saveCutPrompt(
      props.jobId,
      body,
      creatorOperationKey("cut-prompt", identity.value, body),
    ),
  onSuccess: (value) => {
    if (loaded.value !== identity.value) return;
    clearCreatorOperationKey("cut-prompt", identity.value);
    client.setQueryData(
      ["cut-prompt", props.jobId, props.sourceVersion],
      value,
    );
    success.value = `Cut prompt revision ${value.currentRevision} сохранён.`;
    dirty.value = false;
  },
  onError: (cause) => {
    const e = cause as CreatorContextApiError;
    error.value =
      e.status === 409
        ? "Upstream context или prompt изменились. Загрузите server revision."
        : e.message;
  },
});
function close(value: boolean) {
  if (
    !value &&
    dirty.value &&
    !confirm("Несохранённые изменения будут потеряны. Закрыть?")
  )
    return;
  emit("update:visible", value);
}
</script>
<template>
  <Dialog
    :visible="visible && enabled"
    modal
    :draggable="false"
    :header="`Контекст · ${filename}`"
    :style="{ width: 'min(62rem, calc(100vw - 2rem))' }"
    @update:visible="close"
    ><p>
      Exact source version: {{ sourceVersion }}. Новая upstream revision не
      перепривязывает этот cut prompt автоматически.
    </p>
    <p v-if="context.isLoading.value || prompt.isLoading.value" role="status">
      Восстанавливаем сохранённый контекст…
    </p>
    <template v-else
      ><section>
        <h3>Source context</h3>
        <p
          v-if="context.data.value?.revision.status === 'STALE'"
          class="warning"
        >
          Source context устарел: создайте следующую revision с актуальным
          профилем.
        </p>
        <p v-if="context.data.value?.revision.blockers.length" class="warning">
          Blockers: {{ context.data.value.revision.blockers.join(", ") }}
        </p>
        <label
          >Профиль<Select
            v-model="sourceForm.creatorProfileId"
            :options="profiles.data.value ?? []"
            option-label="canonicalDisplayName"
            option-value="id" /></label
        ><label
          >Revision профиля<input
            v-model.number="sourceForm.creatorProfileRevision"
            type="number"
            min="1"
            step="1"
            @input="dirty = true" /></label
        ><label
          >Название исходника<InputText
            v-model="sourceForm.sourceTitle"
            @input="dirty = true" /></label
        ><label
          >Игра или тема<InputText
            v-model="sourceForm.gameOrTopic"
            @input="dirty = true" /></label
        ><label
          >Аудитория<Textarea
            v-model="sourceForm.audience"
            @input="dirty = true" /></label
        ><label
          >Редакционная цель<Textarea
            v-model="sourceForm.editorialGoal"
            @input="dirty = true" /></label
        ><label
          >Язык<InputText
            v-model="sourceForm.language"
            @input="dirty = true" /></label
        ><label
          >CTA по умолчанию<Textarea
            v-model="sourceForm.defaultCta"
            @input="dirty = true" /></label
        ><label
          >Ограничения, одна на строку<Textarea
            v-model="sourceForm.restrictionsText"
            @input="dirty = true" /></label
        ><label
          >Private notes<Textarea
            v-model="sourceForm.operatorNotes"
            @input="dirty = true" /></label
        ><Button
          label="Сохранить source context revision"
          :loading="saveContext.isPending.value"
          @click="
            () => {
              const value = sourcePayload();
              if (value) saveContext.mutate(value);
            }
          "
        />
      </section>
      <section>
        <h3>Prompt готовой нарезки</h3>
        <p
          v-if="prompt.data.value?.revision.status === 'STALE'"
          class="warning"
        >
          Prompt устарел из-за upstream revision. Создайте следующую revision.
        </p>
        <p v-if="prompt.data.value?.revision.blockers.length" class="warning">
          Blockers: {{ prompt.data.value.revision.blockers.join(", ") }}
        </p>
        <label
          >Что происходит<Textarea
            v-model="promptForm.whatHappens"
            @input="dirty = true" /></label
        ><label
          >Желаемый угол<Textarea
            v-model="promptForm.desiredAngle"
            @input="dirty = true" /></label
        ><label
          >Тон<InputText
            v-model="promptForm.tone"
            @input="dirty = true" /></label
        ><label
          >CTA<Textarea v-model="promptForm.cta" @input="dirty = true" /></label
        ><label
          >Ограничения, одна на строку<Textarea
            v-model="promptForm.restrictionsText"
            @input="dirty = true" /></label
        ><Button
          label="Сохранить cut prompt revision"
          :loading="savePrompt.isPending.value"
          @click="
            () => {
              const value = promptPayload();
              if (value) savePrompt.mutate(value);
            }
          "
        /></section
    ></template>
    <p v-if="error" class="error" role="alert">
      {{ error }}
      <Button
        label="Загрузить server revision"
        severity="secondary"
        @click="
          context.refetch();
          prompt.refetch();
          loaded = '';
        "
      />
    </p>
    <p v-if="success" role="status">{{ success }}</p></Dialog
  >
</template>
<style scoped>
section {
  padding: 1rem 0;
  border-top: 1px solid #d5ddd7;
}
label {
  display: grid;
  gap: 0.3rem;
  margin: 0.65rem 0;
}
.error {
  color: #991b1b;
}
.warning {
  color: #7c4a03;
}
</style>
