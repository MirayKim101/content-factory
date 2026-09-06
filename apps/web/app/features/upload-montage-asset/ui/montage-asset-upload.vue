<script setup lang="ts">
import Button from "primevue/button";
import Message from "primevue/message";
import ProgressBar from "primevue/progressbar";
import Select from "primevue/select";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  createMontageAssetsApi,
  MontageAssetsAbortError,
  MontageAssetsApiError,
  MontageAssetsNetworkError,
} from "~/shared/api/montage-assets";
import {
  clearActiveMontageAttempt,
  fingerprintMontageFile,
  loadActiveMontageAttempt,
  matchesMontageAttempt,
  saveActiveMontageAttempt,
  type ActiveMontageAttempt,
} from "~/features/upload-montage-asset/model/active-montage-attempt-storage";
import {
  montageKinds,
  validateMontageUpload,
  type MontageUploadDraft,
} from "~/features/upload-montage-asset/model/montage-upload-form";
import { nextMontageUploadProgress } from "~/features/upload-montage-asset/model/montage-upload-progress";

const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ uploaded: []; activity: [active: boolean] }>();
const config = useRuntimeConfig();
const api = createMontageAssetsApi({ apiBasePath: config.public.apiBasePath });
const fileInput = ref<HTMLInputElement>();
const draft = ref<MontageUploadDraft>({ kind: "ADVERTISEMENT", file: null });
const errors = ref<Record<string, string>>({});
const pending = ref(false);
const requestError = ref<string>();
const uploadProgress = ref(0);
const idempotencyKey = ref<string>();
const recoveredAttempt = ref<ActiveMontageAttempt>();
const recoveryMismatch = ref<ActiveMontageAttempt>();
let activeController: AbortController | undefined;
let disposed = false;
let submissionRevision = 0;

const fileSummary = computed(() =>
  draft.value.file
    ? `${draft.value.file.name} · ${(draft.value.file.size / 1024 / 1024).toFixed(1)} МБ`
    : "Файл не выбран",
);
function selectFile(): void {
  fileInput.value?.click();
}
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  draft.value = { ...draft.value, file };
  errors.value = {};
  requestError.value = undefined;
  uploadProgress.value = 0;
  if (!file) return;
  const active = recoveredAttempt.value ?? loadActiveMontageAttempt();
  if (
    active &&
    matchesMontageAttempt(active, props.projectId, draft.value.kind, file)
  ) {
    idempotencyKey.value = active.idempotencyKey;
    recoveredAttempt.value = active;
    recoveryMismatch.value = undefined;
    return;
  }
  if (active) recoveryMismatch.value = active;
  recoveredAttempt.value = undefined;
  idempotencyKey.value = undefined;
}
function onKindChange(kind: MontageUploadDraft["kind"]): void {
  draft.value = { ...draft.value, kind };
  errors.value = {};
  requestError.value = undefined;
  const active = recoveredAttempt.value ?? loadActiveMontageAttempt();
  if (active) recoveryMismatch.value = active;
  recoveredAttempt.value = undefined;
  idempotencyKey.value = undefined;
}
function discardRecoveredAttempt(): void {
  clearActiveMontageAttempt();
  recoveredAttempt.value = undefined;
  recoveryMismatch.value = undefined;
}
async function submit(): Promise<void> {
  if (pending.value) return;
  if (recoveryMismatch.value) {
    errors.value = {
      file: "Сначала восстановите исходный файл или явно отмените сохранённую попытку.",
    };
    return;
  }
  const parsed = validateMontageUpload(draft.value);
  if (!parsed.success) {
    errors.value = parsed.errors;
    return;
  }
  uploadProgress.value = 0;
  pending.value = true;
  emit("activity", true);
  requestError.value = undefined;
  const projectId = props.projectId;
  const kind = parsed.data.kind;
  const file = parsed.data.file;
  const key = idempotencyKey.value ?? `web-montage-${crypto.randomUUID()}`;
  const revision = ++submissionRevision;
  idempotencyKey.value = key;
  saveActiveMontageAttempt({
    idempotencyKey: key,
    projectId,
    kind,
    fingerprint: fingerprintMontageFile(file),
  });
  const controller = new AbortController();
  activeController = controller;
  try {
    await api.upload({
      projectId,
      kind,
      file,
      idempotencyKey: key,
      signal: controller.signal,
      onUploadProgress: ({ loaded, total }) => {
        uploadProgress.value = nextMontageUploadProgress(uploadProgress.value, {
          loaded,
          total,
        });
      },
    });
    if (revision !== submissionRevision) return;
    uploadProgress.value = 100;
    draft.value = { kind: draft.value.kind, file: null };
    if (fileInput.value) fileInput.value.value = "";
    clearActiveMontageAttempt();
    recoveredAttempt.value = undefined;
    idempotencyKey.value = undefined;
    emit("uploaded");
  } catch (error) {
    if (revision !== submissionRevision) return;
    if (disposed || controller.signal.aborted) return;
    if (error instanceof MontageAssetsAbortError) {
      if (!disposed) requestError.value = "Загрузка отменена.";
      return;
    }
    requestError.value =
      error instanceof MontageAssetsNetworkError
        ? "Сеть не ответила. Повторите попытку: система использует тот же ключ и не создаст дубликат."
        : error instanceof MontageAssetsApiError
          ? error.message
          : "Не удалось загрузить материал.";
  } finally {
    if (activeController === controller && revision === submissionRevision) {
      activeController = undefined;
      pending.value = false;
      emit("activity", false);
    }
  }
}
onMounted(() => {
  const active = loadActiveMontageAttempt();
  if (active?.projectId !== props.projectId) return;
  recoveredAttempt.value = active;
  draft.value = { ...draft.value, kind: active.kind };
  idempotencyKey.value = active.idempotencyKey;
});
onBeforeUnmount(() => {
  disposed = true;
  activeController?.abort();
});
watch(
  () => props.projectId,
  () => {
    submissionRevision += 1;
    activeController?.abort();
    activeController = undefined;
    pending.value = false;
    emit("activity", false);
    requestError.value = undefined;
    errors.value = {};
    uploadProgress.value = 0;
    draft.value = { kind: "ADVERTISEMENT", file: null };
    if (fileInput.value) fileInput.value.value = "";
    const active = loadActiveMontageAttempt();
    if (active?.projectId === props.projectId) {
      recoveredAttempt.value = active;
      draft.value = { ...draft.value, kind: active.kind };
      idempotencyKey.value = active.idempotencyKey;
    } else {
      recoveredAttempt.value = undefined;
      idempotencyKey.value = undefined;
    }
  },
);
</script>

<template>
  <form class="montage-upload" @submit.prevent="submit">
    <label for="montage-kind">Тип материала</label>
    <Select
      input-id="montage-kind"
      :model-value="draft.kind"
      :options="montageKinds"
      option-label="label"
      option-value="value"
      :disabled="pending"
      @update:model-value="onKindChange"
    />
    <p class="limit-note">
      MP4: до 256 МБ и 3 минут; баннер: JPEG, PNG или WebP до 10 МБ.
    </p>
    <input
      ref="fileInput"
      class="sr-only"
      type="file"
      :accept="
        draft.kind === 'BANNER'
          ? 'image/jpeg,image/png,image/webp'
          : 'video/mp4'
      "
      :disabled="pending"
      @change="onFileChange"
    />
    <div class="file-choice">
      <Button
        type="button"
        severity="secondary"
        label="Выбрать файл"
        :disabled="pending"
        @click="selectFile"
      />
      <span>{{ fileSummary }}</span>
    </div>
    <p v-if="errors.file" class="field-error" role="alert">{{ errors.file }}</p>
    <Message v-if="recoveryMismatch" severity="warn" :closable="false">
      Есть незавершённая загрузка для другого файла, типа или проекта. Выберите
      исходный файл для её повтора либо явно отмените её перед новой загрузкой.
      <Button
        type="button"
        severity="secondary"
        label="Отменить сохранённую попытку"
        :disabled="pending"
        @click="discardRecoveredAttempt"
      />
    </Message>
    <ProgressBar
      v-if="pending || uploadProgress === 100"
      :value="uploadProgress"
    >
      {{ uploadProgress }}%
    </ProgressBar>
    <Message v-if="requestError" severity="error" :closable="false">{{
      requestError
    }}</Message>
    <Button
      type="submit"
      :loading="pending"
      :disabled="pending"
      label="Загрузить материал"
    />
  </form>
</template>

<style scoped>
.montage-upload {
  display: grid;
  gap: 0.65rem;
}
.montage-upload label {
  font-weight: 700;
}
.limit-note {
  margin: 0;
  color: #4e5d53;
  font-size: 0.9rem;
}
.file-choice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.field-error {
  margin: 0;
  color: #a42626;
}
</style>
