<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import {
  computed,
  reactive,
  ref,
  watch,
  onBeforeUnmount,
  onMounted,
} from "vue";
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
let alive = true;
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
const promptBinding = reactive({
  sourceContextId: "",
  sourceContextRevision: 0,
});
const sourceBaseline = ref(JSON.stringify(sourceForm));
const promptSnapshot = () =>
  JSON.stringify({ ...promptForm, ...promptBinding });
const promptBaseline = ref(promptSnapshot());
const sourceDirty = computed(
  () => JSON.stringify(sourceForm) !== sourceBaseline.value,
);
const promptDirty = computed(() => promptSnapshot() !== promptBaseline.value);
const dirty = computed(() => sourceDirty.value || promptDirty.value);
const sourceRevision = ref(0),
  promptRevision = ref(0);
const profiles = useQuery({
  queryKey: ["creator-profiles"],
  queryFn: api.listProfiles,
  enabled: computed(() => props.visible && enabled.value),
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
const absent = (cause: unknown) =>
  cause instanceof CreatorContextApiError && cause.status === 404;
const readError = computed(
  () =>
    (context.error.value && !absent(context.error.value)) ||
    (prompt.error.value && !absent(prompt.error.value)) ||
    profiles.error.value,
);
function hydrateSource() {
  const c = context.data.value?.revision.editableRevision;
  Object.assign(sourceForm, {
    creatorProfileId: c?.creatorProfileId ?? "",
    creatorProfileRevision: c?.creatorProfileRevision ?? 0,
    sourceTitle: c?.sourceTitle ?? props.filename,
    gameOrTopic: c?.gameOrTopic ?? "",
    audience: c?.audience ?? "",
    editorialGoal: c?.editorialGoal ?? "",
    language: c?.language ?? "",
    defaultCta: c?.defaultCta ?? "",
    restrictionsText: c?.restrictions.join("\n") ?? "",
    operatorNotes: c?.operatorNotes ?? "",
  });
  sourceRevision.value = context.data.value?.currentRevision ?? 0;
  sourceBaseline.value = JSON.stringify(sourceForm);
}
function hydratePrompt() {
  const p = prompt.data.value?.revision.editableRevision;
  Object.assign(promptForm, {
    whatHappens: p?.whatHappens ?? "",
    desiredAngle: p?.desiredAngle ?? "",
    tone: p?.tone ?? "",
    cta: p?.cta ?? "",
    restrictionsText: p?.restrictions.join("\n") ?? "",
  });
  promptBinding.sourceContextId =
    p?.sourceContextId ?? context.data.value?.id ?? "";
  promptBinding.sourceContextRevision =
    p?.sourceContextRevision ?? context.data.value?.currentRevision ?? 0;
  promptRevision.value = prompt.data.value?.currentRevision ?? 0;
  promptBaseline.value = promptSnapshot();
}
watch(
  [
    () => context.data.value,
    () => prompt.data.value,
    () => context.isFetching.value,
    () => prompt.isFetching.value,
    identity,
    () => props.visible,
  ],
  () => {
    if (
      !props.visible ||
      context.isFetching.value ||
      prompt.isFetching.value ||
      readError.value
    )
      return;
    if (loaded.value && loaded.value !== identity.value && dirty.value) {
      error.value =
        "Источник изменился. Черновик прежнего источника сохранён; загрузите новую версию явно.";
      return;
    }
    if (!sourceDirty.value) hydrateSource();
    if (!promptDirty.value) hydratePrompt();
    loaded.value = identity.value;
  },
  { immediate: true },
);
function chooseProfile() {
  const selected = profiles.data.value?.find(
    (item) => item.id === sourceForm.creatorProfileId,
  );
  if (selected) sourceForm.creatorProfileRevision = selected.currentRevision;
}
function bindPrompt() {
  const source = context.data.value;
  if (!source) return;
  promptBinding.sourceContextId = source.id;
  promptBinding.sourceContextRevision = source.currentRevision;
}
function sourcePayload():
  (SourceContextInput & { expectedRevision: number }) | undefined {
  const result = sourceContextFormSchema.safeParse(sourceForm);
  if (!result.success) {
    error.value = result.error.issues[0]?.message;
    return;
  }
  const { restrictionsText, ...rest } = result.data;
  return {
    ...rest,
    restrictions: restrictionsText,
    expectedRevision: sourceRevision.value,
  };
}
function promptPayload():
  (CutPromptInput & { expectedRevision: number }) | undefined {
  if (!promptBinding.sourceContextId) {
    error.value =
      "Сначала сохраните контекст исходника и свяжите с ним инструкцию.";
    return;
  }
  const result = promptFormSchema.safeParse(promptForm);
  if (!result.success) {
    error.value = result.error.issues[0]?.message;
    return;
  }
  const { restrictionsText, ...rest } = result.data;
  return {
    ...rest,
    ...promptBinding,
    restrictions: restrictionsText,
    expectedRevision: promptRevision.value,
  };
}
function report(cause: unknown) {
  const e = cause instanceof Error ? cause : new Error("Не удалось сохранить.");
  error.value =
    e instanceof CreatorContextApiError && e.status === 409
      ? "Контекст изменился. Черновик сохранён; загрузите актуальную версию явно, перезапись запрещена."
      : e.message;
  success.value = undefined;
}
type Target = {
  identity: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  jobId: string;
  key: string;
  target: string;
  snapshot: string;
};
type SourceRequest = Target & {
  body: NonNullable<ReturnType<typeof sourcePayload>>;
};
type PromptRequest = Target & {
  body: NonNullable<ReturnType<typeof promptPayload>>;
};
const current = (r: Target) =>
  alive &&
  props.visible &&
  r.identity === identity.value &&
  loaded.value === identity.value;
const saveContext = useMutation({
  mutationFn: (r: SourceRequest) =>
    api.saveSourceContext(
      r.projectId,
      r.sourceId,
      r.sourceVersion,
      r.body,
      r.key,
    ),
  onSuccess: (value, r) => {
    clearCreatorOperationKey("source-context", r.target, r.key);
    void client.cancelQueries({
      queryKey: ["source-context", r.projectId, r.sourceId, r.sourceVersion],
      exact: true,
    });
    client.setQueryData(
      ["source-context", r.projectId, r.sourceId, r.sourceVersion],
      value,
    );
    void client.invalidateQueries({
      queryKey: ["cut-prompt", r.jobId, r.sourceVersion],
    });
    if (!current(r)) return;
    sourceRevision.value = value.currentRevision;
    sourceBaseline.value = r.snapshot;
    error.value = undefined;
    success.value = `Контекст исходника: версия ${value.currentRevision} сохранена.`;
  },
  onError: (cause, r) => {
    if (current(r)) report(cause);
  },
});
const savePrompt = useMutation({
  mutationFn: (r: PromptRequest) => api.saveCutPrompt(r.jobId, r.body, r.key),
  onSuccess: (value, r) => {
    clearCreatorOperationKey("cut-prompt", r.target, r.key);
    void client.cancelQueries({
      queryKey: ["cut-prompt", r.jobId, r.sourceVersion],
      exact: true,
    });
    client.setQueryData(["cut-prompt", r.jobId, r.sourceVersion], value);
    if (!current(r)) return;
    promptRevision.value = value.currentRevision;
    promptBaseline.value = r.snapshot;
    error.value = undefined;
    success.value = `Инструкция к нарезке: версия ${value.currentRevision} сохранена.`;
  },
  onError: (cause, r) => {
    if (current(r)) report(cause);
  },
});
function submit(kind: "source-context" | "cut-prompt") {
  if (
    loaded.value !== identity.value ||
    readError.value ||
    saveContext.isPending.value ||
    savePrompt.isPending.value
  )
    return;
  const target =
    kind === "source-context"
      ? `${props.projectId}:${props.sourceId}:${props.sourceVersion}`
      : props.jobId;
  const common = {
    identity: identity.value,
    projectId: props.projectId,
    sourceId: props.sourceId,
    sourceVersion: props.sourceVersion,
    jobId: props.jobId,
    target,
  };
  try {
    if (kind === "source-context") {
      const body = sourcePayload();
      if (body)
        saveContext.mutate({
          ...common,
          body,
          key: creatorOperationKey(kind, target, body),
          snapshot: JSON.stringify(sourceForm),
        });
    } else {
      const body = promptPayload();
      if (body)
        savePrompt.mutate({
          ...common,
          body,
          key: creatorOperationKey(kind, target, body),
          snapshot: promptSnapshot(),
        });
    }
  } catch (cause) {
    report(cause);
  }
}
function canDiscard() {
  return (
    !dirty.value ||
    confirm("Несохранённые изменения будут потеряны. Продолжить?")
  );
}
function close(value: boolean) {
  if (value || canDiscard()) emit("update:visible", value);
}
async function reload() {
  if (!canDiscard()) return;
  const target = identity.value;
  const results = await Promise.all([
    context.refetch(),
    prompt.refetch(),
    profiles.refetch(),
  ]);
  if (!alive || target !== identity.value) return;
  const failure = results.find(
    (result) => result.error && !absent(result.error),
  );
  if (failure?.error) {
    report(failure.error);
    return;
  }
  hydrateSource();
  hydratePrompt();
  loaded.value = identity.value;
  error.value = undefined;
  success.value = undefined;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  alive = false;
  window.removeEventListener("beforeunload", beforeUnload);
});
defineExpose({ canDiscard });
</script>
<template>
  <Dialog
    :visible="visible && enabled"
    modal
    block-scroll
    :draggable="false"
    :header="`Контекст · ${filename}`"
    :close-button-props="{ 'aria-label': 'Закрыть контекст' }"
    :style="{ width: 'min(62rem, calc(100vw - 2rem))' }"
    :pt="{
      root: { class: 'creator-context-dialog-root' },
      mask: { class: 'creator-context-dialog-mask' },
      header: { class: 'creator-context-dialog-header' },
      title: { class: 'creator-context-dialog-title' },
      pcCloseButton: { root: { class: 'creator-context-dialog-close' } },
      content: { class: 'creator-context-dialog-body' },
    }"
    @update:visible="close"
    ><p>
      Версия исходника: {{ sourceVersion }}. Новая версия профиля или контекста
      не меняет сохранённую инструкцию автоматически.
    </p>
    <p v-if="context.isLoading.value || prompt.isLoading.value" role="status">
      Восстанавливаем сохранённый контекст…
    </p>
    <p v-else-if="readError" role="alert">
      Не удалось загрузить контекст. Ручной редакционный поток остаётся
      доступен.<Button label="Повторить загрузку" @click="reload" />
    </p>
    <template v-else
      ><section>
        <h3>Контекст исходника</h3>
        <p
          v-if="context.data.value?.revision.status === 'STALE'"
          class="warning"
        >
          Контекст устарел: сохраните новую версию с актуальным профилем.
        </p>
        <p v-if="context.data.value?.revision.blockers.length" class="warning">
          Причины: {{ context.data.value.revision.blockers.join(", ") }}
        </p>
        <label
          >Профиль<Select
            v-model="sourceForm.creatorProfileId"
            :options="profiles.data.value ?? []"
            option-label="canonicalDisplayName"
            option-value="id"
            placeholder="Выберите профиль"
            aria-label="Профиль"
            :pt="{
              root: { class: 'creator-context-select' },
              label: { class: 'creator-context-select-label' },
              dropdown: { class: 'creator-context-select-dropdown' },
              overlay: { class: 'creator-context-select-overlay' },
              listContainer: { class: 'creator-context-select-list-container' },
              option: { class: 'creator-context-select-option' },
            }"
            @change="chooseProfile" /></label
        ><label
          >Версия профиля<input
            class="creator-context-field"
            v-model.number="sourceForm.creatorProfileRevision"
            type="number"
            min="1"
            step="1" /></label
        ><label
          >Название исходника<InputText
            class="creator-context-field"
            v-model="sourceForm.sourceTitle" /></label
        ><label
          >Игра или тема<InputText
            class="creator-context-field"
            v-model="sourceForm.gameOrTopic" /></label
        ><label
          >Аудитория<Textarea
            class="creator-context-field"
            v-model="sourceForm.audience" /></label
        ><label
          >Редакционная цель<Textarea
            class="creator-context-field"
            v-model="sourceForm.editorialGoal" /></label
        ><label
          >Язык<InputText
            class="creator-context-field"
            v-model="sourceForm.language" /></label
        ><label
          >Призыв к действию по умолчанию<Textarea
            class="creator-context-field"
            v-model="sourceForm.defaultCta" /></label
        ><label
          >Ограничения, одна на строку<Textarea
            class="creator-context-field"
            v-model="sourceForm.restrictionsText" /></label
        ><label
          >Личные заметки<Textarea
            class="creator-context-field"
            v-model="sourceForm.operatorNotes" /></label
        ><Button
          label="Сохранить контекст исходника"
          :loading="saveContext.isPending.value"
          :disabled="
            saveContext.isPending.value ||
            savePrompt.isPending.value ||
            loaded !== identity
          "
          @click="submit('source-context')"
        />
      </section>
      <section>
        <h3>Инструкция к готовой нарезке</h3>
        <p>
          Связанная версия контекста:
          {{ promptBinding.sourceContextRevision || "не выбрана" }}. Текущая:
          {{ context.data.value?.currentRevision ?? "не создана" }}.
        </p>
        <Button
          v-if="
            context.data.value &&
            (promptBinding.sourceContextId !== context.data.value.id ||
              promptBinding.sourceContextRevision !==
                context.data.value.currentRevision)
          "
          label="Связать с текущей версией контекста"
          @click="bindPrompt"
        />
        <p
          v-if="prompt.data.value?.revision.status === 'STALE'"
          class="warning"
        >
          Инструкция устарела после изменения контекста. Свяжите её с актуальной
          версией.
        </p>
        <p v-if="prompt.data.value?.revision.blockers.length" class="warning">
          Причины: {{ prompt.data.value.revision.blockers.join(", ") }}
        </p>
        <label
          >Что происходит<Textarea
            class="creator-context-field"
            v-model="promptForm.whatHappens" /></label
        ><label
          >Желаемый акцент<Textarea
            class="creator-context-field"
            v-model="promptForm.desiredAngle" /></label
        ><label
          >Тон<InputText
            class="creator-context-field"
            v-model="promptForm.tone" /></label
        ><label
          >Призыв к действию<Textarea
            class="creator-context-field"
            v-model="promptForm.cta" /></label
        ><label
          >Ограничения, одна на строку<Textarea
            class="creator-context-field"
            v-model="promptForm.restrictionsText" /></label
        ><Button
          label="Сохранить инструкцию к нарезке"
          :loading="savePrompt.isPending.value"
          :disabled="
            saveContext.isPending.value ||
            savePrompt.isPending.value ||
            loaded !== identity
          "
          @click="submit('cut-prompt')"
        /></section
    ></template>
    <p v-if="error" class="error" role="alert">
      {{ error }}
      <Button
        label="Загрузить актуальную версию"
        severity="secondary"
        @click="reload"
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

<style>
/* PrimeVue is unstyled and teleports overlays to body; use the existing
   editorial-dialog pass-through pattern with component-specific global classes. */
.creator-context-dialog-mask {
  z-index: 1200;
  padding: 1rem;
  background: rgb(15 23 42 / 0.45);
}
.creator-context-dialog-root {
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
.creator-context-dialog-header {
  display: flex;
  flex: 0 0 auto;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid #d9e0d8;
  background: #fff;
}
.creator-context-dialog-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.creator-context-dialog-close {
  display: inline-grid;
  flex: 0 0 2.5rem;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.creator-context-dialog-close:focus-visible,
.creator-context-dialog-close:hover {
  background: #edf2ee;
  color: #183c2b;
}
.creator-context-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem;
  background: #fff;
}
.creator-context-field,
.creator-context-select {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid #9aa89f;
  border-radius: 0.45rem;
  background: #fff;
  color: #152018;
}
textarea.creator-context-field {
  min-height: 5rem;
  resize: vertical;
}
.creator-context-field:focus,
.creator-context-select:focus-within {
  outline: 3px solid rgb(35 77 53 / 0.24);
  outline-offset: 1px;
  border-color: #234d35;
}
.creator-context-select {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  padding: 0;
}
.creator-context-select-label {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.7rem;
}
.creator-context-select-dropdown {
  display: grid;
  width: 2.5rem;
  min-height: 2.5rem;
  place-items: center;
  border-left: 1px solid #c4cec7;
}
.creator-context-select-overlay {
  z-index: 1300;
  border: 1px solid #9aa89f;
  border-radius: 0.45rem;
  background: #fff;
  color: #152018;
  box-shadow: 0 12px 32px rgb(15 23 42 / 0.2);
}
.creator-context-select-list-container {
  max-height: 14rem;
  overflow: auto;
}
.creator-context-select-option {
  padding: 0.55rem 0.7rem;
  cursor: pointer;
}
.creator-context-select-option:hover,
.creator-context-select-option[aria-selected="true"],
.creator-context-select-option[data-p-focused="true"] {
  background: #edf2ee;
}
</style>
