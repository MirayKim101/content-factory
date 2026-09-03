<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { computed, reactive, ref, watch } from "vue";

import {
  editorialPackageFormSchema,
  parseOrderedTags,
  validateThumbnailFile,
  type EditorialPackageForm,
} from "~/features/edit-editorial-package/model/editorial-package-form";
import {
  idempotencyForEditorialOperation,
  idempotencyForEditorialSave,
  thumbnailUploadFingerprint,
  type EditorialOperationAttempt,
  type EditorialSaveAttempt,
} from "~/features/edit-editorial-package/model/save-identity";
import {
  createEditorialContentApi,
  EditorialApiError,
  type EditorialPackage,
} from "~/shared/api/editorial-content";

const props = defineProps<{
  visible: boolean;
  projectId: string;
  jobId: string;
  filename: string;
}>();
const emit = defineEmits<{ "update:visible": [value: boolean] }>();
const config = useRuntimeConfig();
const api = createEditorialContentApi(config.public.apiBasePath);
const queryClient = useQueryClient();
const form = reactive<EditorialPackageForm>({
  title: "",
  description: "",
  tagsText: "",
  processingTemplateRevisionId: "",
  thumbnailAssetId: null,
});
const formError = ref<string>();
const saveError = ref<string>();
const success = ref<string>();
const uploadError = ref<string>();
const createTemplateName = ref("");
const saveAttempt = ref<EditorialSaveAttempt>();
const templateAttempt = ref<EditorialOperationAttempt>();
const thumbnailAttempt = ref<EditorialOperationAttempt>();
const thumbnailPreparing = ref(false);
const serverRevision = ref(0);
const loadedIdentity = ref<string>();
const loadedFormFingerprint = ref("");
const reloadArmed = ref(false);

const packages = useQuery({
  queryKey: computed(() => ["editorial-packages", props.projectId]),
  queryFn: () => api.listProjectPackages(props.projectId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: 1,
});
const templates = useQuery({
  queryKey: ["processing-templates"],
  queryFn: api.listTemplates,
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: 1,
});
const thumbnails = useQuery({
  queryKey: computed(() => ["editorial-thumbnails", props.projectId]),
  queryFn: () => api.listThumbnails(props.projectId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: 1,
});
const currentPackage = computed(() =>
  packages.data.value?.find((item) => item.pipelineJobId === props.jobId),
);
const hydrationReady = computed(
  () =>
    packages.data.value !== undefined &&
    templates.data.value !== undefined &&
    thumbnails.data.value !== undefined &&
    packages.isFetchedAfterMount.value &&
    templates.isFetchedAfterMount.value &&
    thumbnails.isFetchedAfterMount.value,
);
const isLoading = computed(
  () =>
    Boolean(props.visible) &&
    !hydrationReady.value &&
    (packages.isFetching.value ||
      templates.isFetching.value ||
      thumbnails.isFetching.value),
);
const canSave = computed(
  () =>
    packages.data.value !== undefined &&
    templates.data.value !== undefined &&
    !packages.isError.value &&
    !templates.isError.value,
);
const selectedThumbnail = computed(() =>
  thumbnails.data.value?.find((item) => item.id === form.thumbnailAssetId),
);

function loadPackage(value: EditorialPackage | undefined): void {
  if (value) {
    serverRevision.value = value.revision.revision;
    form.title = value.revision.title ?? "";
    form.description = value.revision.description ?? "";
    form.tagsText = value.revision.tags?.join("\n") ?? "";
    form.processingTemplateRevisionId =
      value.revision.processingTemplateRevision.id;
    form.thumbnailAssetId = value.revision.thumbnail?.id ?? null;
  } else {
    serverRevision.value = 0;
    if (!form.processingTemplateRevisionId && templates.data.value?.[0])
      form.processingTemplateRevisionId = templates.data.value[0].id;
  }
  loadedFormFingerprint.value = formFingerprint();
  reloadArmed.value = false;
}
watch(
  [currentPackage, hydrationReady, () => props.visible],
  ([value, ready, visible]) => {
    const identity = `${props.projectId}:${props.jobId}`;
    if (visible && ready && loadedIdentity.value !== identity) {
      loadPackage(value);
      loadedIdentity.value = identity;
    }
  },
  { immediate: true },
);
watch(
  () => [props.visible, props.projectId, props.jobId],
  ([visible]) => {
    if (!visible) {
      formError.value = undefined;
      saveError.value = undefined;
      success.value = undefined;
      uploadError.value = undefined;
      saveAttempt.value = undefined;
      templateAttempt.value = undefined;
      thumbnailAttempt.value = undefined;
      thumbnailPreparing.value = false;
      loadedIdentity.value = undefined;
      loadedFormFingerprint.value = "";
      reloadArmed.value = false;
    }
  },
);

function formFingerprint(): string {
  return JSON.stringify({
    title: form.title,
    description: form.description,
    tagsText: form.tagsText,
    processingTemplateRevisionId: form.processingTemplateRevisionId,
    thumbnailAssetId: form.thumbnailAssetId,
  });
}
const hasUnsavedChanges = computed(
  () =>
    Boolean(loadedFormFingerprint.value) &&
    formFingerprint() !== loadedFormFingerprint.value,
);
function payload():
  | {
      expectedRevision: number;
      processingTemplateRevisionId: string;
      title: string | null;
      description: string | null;
      tags: string[] | null;
      thumbnailAssetId: string | null;
    }
  | undefined {
  const parsed = editorialPackageFormSchema.safeParse(form);
  if (!parsed.success) {
    formError.value = "Проверьте длину полей и выберите revision шаблона.";
    return undefined;
  }
  const tags = parseOrderedTags(parsed.data.tagsText);
  if (tags?.some((tag) => tag.length > 100) || (tags?.length ?? 0) > 30) {
    formError.value = "Нужно не более 30 тегов, каждый до 100 символов.";
    return undefined;
  }
  formError.value = undefined;
  return {
    expectedRevision: serverRevision.value,
    processingTemplateRevisionId: parsed.data.processingTemplateRevisionId,
    title: parsed.data.title,
    description: parsed.data.description,
    tags,
    thumbnailAssetId: parsed.data.thumbnailAssetId,
  };
}
interface SaveRequest {
  projectId: string;
  jobId: string;
  identity: string;
  body: NonNullable<ReturnType<typeof payload>>;
  idempotencyKey: string;
}
function currentIdentity(): string {
  return `${props.projectId}:${props.jobId}`;
}
function requestSave(): void {
  if (save.isPending.value) return;
  const body = payload();
  if (!body) return;
  saveAttempt.value = idempotencyForEditorialSave(saveAttempt.value, body, () =>
    crypto.randomUUID(),
  );
  save.mutate({
    projectId: props.projectId,
    jobId: props.jobId,
    identity: currentIdentity(),
    body,
    idempotencyKey: saveAttempt.value.key,
  });
}
const save = useMutation({
  mutationFn: (request: SaveRequest) =>
    api.savePackage(request.jobId, request.body, request.idempotencyKey),
  onSuccess: (value, request) => {
    if (request.identity !== currentIdentity()) return;
    serverRevision.value = value.revision.revision;
    queryClient.setQueryData<EditorialPackage[]>(
      ["editorial-packages", request.projectId],
      (current = []) => [
        ...current.filter((item) => item.pipelineJobId !== request.jobId),
        value,
      ],
    );
    loadPackage(value);
    saveAttempt.value = undefined;
    saveError.value = undefined;
    success.value = value.validation.complete
      ? `Сохранена complete revision ${value.revision.revision}.`
      : `Сохранён неполный черновик. Не хватает: ${value.validation.missingFields.join(", ")}.`;
  },
  onError: async (error, request) => {
    if (request.identity !== currentIdentity()) return;
    if (error instanceof EditorialApiError && error.status === 409) {
      saveError.value =
        "Конфликт revision: текущий ввод сохранён в форме. Обновите данные сервера, затем сохраните свою версию.";
      const refreshed = await packages.refetch();
      const latest = refreshed.data?.find(
        (item) => item.pipelineJobId === request.jobId,
      );
      if (latest) serverRevision.value = latest.revision.revision;
      return;
    }
    saveError.value =
      error instanceof Error ? error.message : "Не удалось сохранить черновик.";
  },
});
const createTemplate = useMutation({
  mutationFn: (request: { name: string; idempotencyKey: string }) =>
    api.createTemplate(request.name, request.idempotencyKey),
  onSuccess: async (value) => {
    createTemplateName.value = "";
    form.processingTemplateRevisionId = value.id;
    templateAttempt.value = undefined;
    await queryClient.invalidateQueries({ queryKey: ["processing-templates"] });
  },
});
function requestCreateTemplate(): void {
  if (createTemplate.isPending.value) return;
  const name = createTemplateName.value.trim();
  if (!name) return;
  templateAttempt.value = idempotencyForEditorialOperation(
    templateAttempt.value,
    `template:${name}`,
    () => crypto.randomUUID(),
  );
  createTemplate.mutate({ name, idempotencyKey: templateAttempt.value.key });
}
interface ThumbnailUploadRequest {
  projectId: string;
  file: File;
  idempotencyKey: string;
}
const upload = useMutation({
  mutationFn: ({ projectId, file, idempotencyKey }: ThumbnailUploadRequest) =>
    api.uploadThumbnail(projectId, file, idempotencyKey),
  onSuccess: async (value, request) => {
    if (request.projectId !== props.projectId) return;
    form.thumbnailAssetId = value.id;
    uploadError.value = undefined;
    thumbnailAttempt.value = undefined;
    await queryClient.invalidateQueries({
      queryKey: ["editorial-thumbnails", request.projectId],
    });
  },
  onError: (error, request) => {
    if (request.projectId !== props.projectId) return;
    uploadError.value =
      error instanceof Error ? error.message : "Не удалось загрузить обложку.";
  },
});
async function chooseFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  uploadError.value = validateThumbnailFile(file);
  if (!uploadError.value && !thumbnailPreparing.value) {
    thumbnailPreparing.value = true;
    try {
      const projectId = props.projectId;
      thumbnailAttempt.value = idempotencyForEditorialOperation(
        thumbnailAttempt.value,
        await thumbnailUploadFingerprint(projectId, file),
        () => crypto.randomUUID(),
      );
      if (projectId === props.projectId)
        upload.mutate({
          projectId,
          file,
          idempotencyKey: thumbnailAttempt.value.key,
        });
    } catch {
      uploadError.value = "Не удалось подготовить обложку к загрузке.";
    } finally {
      thumbnailPreparing.value = false;
    }
  }
  (event.target as HTMLInputElement).value = "";
}
function reloadServerRevision(): void {
  if (hasUnsavedChanges.value && !reloadArmed.value) {
    reloadArmed.value = true;
    saveError.value =
      "Есть несохранённые изменения. Нажмите «Загрузить сохранённую версию» ещё раз, чтобы заменить форму данными сервера.";
    return;
  }
  const identity = currentIdentity();
  void Promise.all([
    packages.refetch(),
    templates.refetch(),
    thumbnails.refetch(),
  ]).then(([result]) => {
    if (identity !== currentIdentity()) return;
    const latest = result.data?.find(
      (item) => item.pipelineJobId === props.jobId,
    );
    loadPackage(latest);
    saveError.value = undefined;
  });
  success.value = undefined;
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :style="{ width: 'min(40rem, calc(100vw - 2rem))' }"
    :pt="{
      root: { class: 'editorial-dialog-root' },
      mask: { class: 'editorial-dialog-mask' },
      header: { class: 'editorial-dialog-header' },
      title: { class: 'editorial-dialog-title' },
      closeButton: { class: 'editorial-dialog-close' },
      content: { class: 'editorial-dialog-body' },
    }"
    :header="`Заголовок и обложка · ${filename}`"
    @update:visible="emit('update:visible', $event)"
  >
    <section
      class="editorial-dialog"
      :aria-busy="isLoading || save.isPending.value"
    >
      <p v-if="isLoading" role="status">
        Загружаем сохранённый черновик, шаблоны и обложки…
      </p>
      <template v-else>
        <p
          v-if="
            packages.isError.value ||
            templates.isError.value ||
            thumbnails.isError.value
          "
          class="error"
          role="alert"
        >
          Не удалось загрузить часть редакционных данных.
          <Button
            label="Повторить загрузку"
            severity="secondary"
            @click="reloadServerRevision"
          />
        </p>
        <form @submit.prevent="requestSave">
          <fieldset class="form-fields" :disabled="save.isPending.value">
            <label
              >Заголовок<InputText
                v-model="form.title"
                maxlength="200"
                :pt="{ root: { class: 'editorial-text-field' } }"
            /></label>
            <label
              >Описание<Textarea
                v-model="form.description"
                rows="4"
                maxlength="5000"
                :pt="{ root: { class: 'editorial-text-field' } }"
            /></label>
            <label
              >Теги по порядку, один на строку<Textarea
                v-model="form.tagsText"
                rows="4"
                maxlength="3030"
                :pt="{ root: { class: 'editorial-text-field' } }"
            /></label>
            <label
              >Версия шаблона
              <Select
                v-model="form.processingTemplateRevisionId"
                :options="templates.data.value ?? []"
                option-label="name"
                option-value="id"
                placeholder="Выберите шаблон"
                :pt="{
                  root: { class: 'editorial-select' },
                  label: { class: 'editorial-select-label' },
                  dropdown: { class: 'editorial-select-dropdown' },
                  overlay: { class: 'editorial-select-overlay' },
                }"
              />
            </label>
            <div class="create-template">
              <InputText
                v-model="createTemplateName"
                maxlength="200"
                placeholder="Название нового шаблона"
                :pt="{ root: { class: 'editorial-text-field' } }"
              />
              <Button
                type="button"
                label="Создать шаблон"
                severity="secondary"
                :disabled="
                  !createTemplateName.trim() || createTemplate.isPending.value
                "
                @click="requestCreateTemplate"
              />
            </div>
            <fieldset>
              <legend>Собственная обложка</legend>
              <input
                aria-label="Загрузить JPEG, PNG или WebP"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                :disabled="upload.isPending.value || thumbnailPreparing"
                @change="chooseFile"
              />
              <p
                v-if="upload.isPending.value || thumbnailPreparing"
                role="status"
              >
                Загружаем и проверяем обложку…
              </p>
              <p v-if="uploadError" class="error" role="alert">
                {{ uploadError }}
              </p>
              <Select
                v-model="form.thumbnailAssetId"
                :options="
                  thumbnails.data.value?.filter(
                    (asset) => asset.status === 'READY',
                  ) ?? []
                "
                option-label="originalFilename"
                option-value="id"
                placeholder="Выберите уже загруженную обложку"
                show-clear
                :pt="{
                  root: { class: 'editorial-select' },
                  label: { class: 'editorial-select-label' },
                  dropdown: { class: 'editorial-select-dropdown' },
                  overlay: { class: 'editorial-select-overlay' },
                }"
              />
              <Button
                v-if="form.thumbnailAssetId"
                type="button"
                label="Очистить обложку"
                severity="secondary"
                text
                @click="form.thumbnailAssetId = null"
              />
              <img
                v-if="selectedThumbnail"
                :src="api.thumbnailContentUrl(projectId, selectedThumbnail.id)"
                :alt="`Выбрана обложка ${selectedThumbnail.originalFilename}`"
              />
            </fieldset>
          </fieldset>
          <p v-if="currentPackage" class="muted">
            Серверная revision: {{ serverRevision }}.
            {{
              currentPackage.validation.complete
                ? "Пакет заполнен."
                : `Не хватает: ${currentPackage.validation.missingFields.join(", ")}.`
            }}
          </p>
          <p v-if="formError" class="error" role="alert">{{ formError }}</p>
          <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
          <p v-if="success" class="success" role="status">{{ success }}</p>
          <div class="actions">
            <Button
              type="button"
              label="Загрузить сохранённую версию"
              severity="secondary"
              :disabled="save.isPending.value"
              @click="reloadServerRevision"
            />
            <Button
              type="submit"
              :label="
                save.isPending.value ? 'Сохраняем…' : 'Сохранить черновик'
              "
              :disabled="
                !canSave || save.isPending.value || upload.isPending.value
              "
            />
          </div>
        </form>
      </template>
    </section>
  </Dialog>
</template>

<style scoped>
.editorial-dialog,
form {
  display: grid;
  gap: 1rem;
}
.form-fields {
  display: grid;
  gap: 1rem;
  margin: 0;
  padding: 0;
  border: 0;
}
label {
  display: grid;
  gap: 0.45rem;
  font-weight: 650;
}
.editorial-text-field,
.editorial-select {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid #9aa89f;
  border-radius: 0.45rem;
  background: #fff;
  color: #152018;
}
.editorial-text-field:focus,
.editorial-select:focus-within {
  outline: 3px solid rgb(35 77 53 / 0.24);
  outline-offset: 1px;
  border-color: #234d35;
}
.editorial-select {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  padding: 0;
}
.editorial-select-label {
  flex: 1;
  padding: 0.55rem 0.7rem;
}
.editorial-select-dropdown {
  display: grid;
  width: 2.5rem;
  min-height: 2.5rem;
  place-items: center;
  border-left: 1px solid #c4cec7;
}
fieldset {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid #d9e0d8;
  border-radius: 0.5rem;
}
img {
  max-width: 12rem;
  max-height: 7rem;
  object-fit: contain;
  border-radius: 0.35rem;
}
.create-template,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.create-template {
  padding: 0.75rem;
  border-radius: 0.5rem;
  background: #f4f7f4;
}
.actions {
  position: sticky;
  bottom: 0;
  padding: 0.75rem 0 0.25rem;
  background: #fff;
}
.error {
  color: #991b1b;
}
.success {
  color: #166534;
}
.muted {
  color: #65736b;
}
</style>

<style>
/* PrimeVue teleports dialogs to body, so these classes must be global. */
.editorial-dialog-mask {
  z-index: 1200;
  background: rgb(15 23 42 / 0.45);
}
.editorial-dialog-root {
  position: relative;
  z-index: 1201;
  display: flex;
  flex-direction: column;
  width: min(40rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  overflow: hidden;
  border: 1px solid #d9e0d8;
  border-radius: 0.875rem;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 0.3);
}
.editorial-dialog-header {
  display: flex;
  flex: 0 0 auto;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid #d9e0d8;
  background: #fff;
}
.editorial-dialog-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editorial-dialog-close {
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
.editorial-dialog-close:hover,
.editorial-dialog-close:focus-visible {
  background: #edf2ee;
}
.editorial-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
  background: #fff;
}
.editorial-select-overlay {
  z-index: 1300;
  border: 1px solid #9aa89f;
  border-radius: 0.45rem;
  background: #fff;
  box-shadow: 0 12px 32px rgb(15 23 42 / 0.2);
}
</style>
