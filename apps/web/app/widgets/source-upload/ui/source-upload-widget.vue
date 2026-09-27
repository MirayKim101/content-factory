<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, ref } from "vue";

import {
  clearActiveAttempt,
  loadActiveAttempt,
  type ActiveAttempt,
} from "~/features/upload-source/model/active-attempt-storage";
import { useSourceUpload } from "~/features/upload-source/model/use-source-upload";
import { createProjectsApi } from "~/shared/api/projects";
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const upload = useSourceUpload(projectsApi);
const {
  draft,
  errors,
  isSubmitting,
  isSending,
  isFinalizing,
  uploadProgress,
  pollError,
  requestError,
  result,
  state,
  submit,
  updateDraft,
  recoverAttempt,
  startNewAttempt,
  prepareRecoveredRetry,
  retryPoll,
} = upload;
const recoveredAttempt = ref<ActiveAttempt | null>(null);
const recoveryMessage = ref<string | null>(null);
const recoveredFile = ref<File | null>(null);
const recoveryLocksForm = computed(() => recoveredAttempt.value !== null);
const canRetryRecoveredUpload = computed(
  () =>
    recoveredAttempt.value?.status === "SENDING" &&
    recoveredFile.value !== null,
);
onMounted(() => {
  recoveredAttempt.value = loadActiveAttempt();
});
function continueRecoveredAttempt(): void {
  if (!recoveredAttempt.value?.projectId) return;
  recoverAttempt(recoveredAttempt.value);
  recoveredAttempt.value = null;
  recoveryMessage.value = null;
}
function resetRecoveredAttempt(): void {
  clearActiveAttempt();
  recoveredAttempt.value = null;
  recoveredFile.value = null;
  recoveryMessage.value = null;
}
async function retryRecoveredUpload(): Promise<void> {
  if (!recoveredAttempt.value || !recoveredFile.value) return;
  if (!prepareRecoveredRetry(recoveredAttempt.value, recoveredFile.value)) {
    recoveryMessage.value =
      "Не удалось подтвердить файл. Выбери тот же файл или сбрось попытку.";
    return;
  }
  recoveredAttempt.value = null;
  recoveredFile.value = null;
  recoveryMessage.value = null;
  await submit();
}
function onFileChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.item(0) ?? null;
  if (file && recoveredAttempt.value?.status === "SENDING") {
    const recovered = recoveredAttempt.value;
    if (
      recovered.fingerprint.size !== file.size ||
      recovered.fingerprint.lastModified !== file.lastModified ||
      recovered.fingerprint.type !== file.type
    ) {
      recoveredFile.value = null;
      recoveryMessage.value =
        "Это не тот же файл. Исходная попытка сохранена: сбрось её перед новой загрузкой.";
      return;
    }
    recoveredFile.value = file;
    recoveryMessage.value =
      "Файл подтверждён. Нажми «Повторить загрузку с тем же ключом».";
    return;
  }
  updateDraft({ file });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)) - 1,
    units.length - 1,
  );
  const value = bytes / 1024 ** (unitIndex + 1);
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value)} ${units[unitIndex]}`;
}
</script>

<template>
  <section class="card" aria-labelledby="source-upload-title">
    <header class="card-header">
      <span class="step-number" aria-hidden="true">01</span>
      <div><h2 id="source-upload-title">Данные исходника</h2><p>Название поможет быстро найти видео в производственной очереди.</p></div>
    </header>
    <div v-if="recoveredAttempt" class="recovery" role="status">
      <p>
        Найдена незавершённая загрузка «{{ recoveredAttempt.name }}». Файл
        {{
          recoveredAttempt.projectId
            ? "уже принят сервером."
            : "нужно подтвердить."
        }}
      </p>
      <p v-if="recoveredAttempt.status === 'SENDING'">
        Выбери тот же MP4 ещё раз. Затем отдельной кнопкой повтори отправку с
        исходным ключом попытки.
      </p>
      <p v-if="recoveryMessage" class="error">{{ recoveryMessage }}</p>
      <Button
        v-if="recoveredAttempt.projectId"
        type="button"
        @click="continueRecoveredAttempt"
        >Продолжить проверку</Button
      >
      <Button
        v-else
        type="button"
        :disabled="!canRetryRecoveredUpload"
        @click="retryRecoveredUpload"
        >Повторить загрузку с тем же ключом</Button
      >
      <Button type="button" severity="secondary" @click="resetRecoveredAttempt"
        >Сбросить и начать новую попытку</Button
      >
    </div>
    <form @submit.prevent="submit">
      <div class="field">
        <label for="project-name">Название проекта</label
        ><InputText
          id="project-name"
          class="w-full rounded-md border border-slate-400 p-3"
          :model-value="draft.name"
          :disabled="isSubmitting || recoveryLocksForm"
          :aria-invalid="Boolean(errors.name)"
          aria-describedby="project-name-help project-name-error"
          maxlength="200"
          required
          @update:model-value="updateDraft({ name: $event })"
        />
        <p id="project-name-help" class="help">От 1 до 200 символов.</p>
        <p v-if="errors.name" id="project-name-error" class="error">
          {{ errors.name }}
        </p>
      </div>
      <div class="field">
        <label for="source-file">Видео для загрузки</label
        ><input
          id="source-file"
          class="w-full rounded-md border border-slate-400 p-3"
          type="file"
          accept="video/mp4,.mp4"
          :disabled="
            isSubmitting ||
            (recoveryLocksForm && recoveredAttempt?.status !== 'SENDING')
          "
          :aria-invalid="Boolean(errors.file)"
          aria-describedby="source-file-help source-file-error"
          required
          @change="onFileChange"
        />
        <p id="source-file-help" class="help">
          MP4 · файл не будет опубликован без отдельного подтверждения.
        </p>
        <p v-if="errors.file" id="source-file-error" class="error">
          {{ errors.file }}
        </p>
      </div>
      <div class="actions">
        <Button
          class="rounded-md bg-emerald-950 px-4 py-3 font-bold text-white"
          type="submit"
          :disabled="isSubmitting || recoveryLocksForm"
          >{{
            isSending
              ? "Отправляем файл…"
              : isFinalizing
                ? "Сервер сохраняет файл…"
                : state === "error" && requestError
                  ? "Повторить"
                  : "Загрузить видео"
          }}</Button
        >
      </div>
    </form>
    <div class="status" aria-live="polite" aria-atomic="true">
      <p v-if="isSending">
        Файл отправляется на сервер. Не закрывай эту страницу.
      </p>
      <div v-if="isSending" class="upload-progress">
        <progress
          :value="uploadProgress.percent"
          max="100"
          aria-label="Прогресс загрузки файла"
        />
        <p>
          <strong>{{ uploadProgress.percent }}%</strong>
          — загружено {{ formatBytes(uploadProgress.loaded) }} из
          {{ formatBytes(uploadProgress.total) }}.
        </p>
      </div>
      <div v-else-if="isFinalizing || pollError">
        <p>Сервер проверяет и сохраняет загруженный файл.</p>
        <p v-if="pollError" class="error">{{ pollError }}</p>
        <Button v-if="pollError" type="button" @click="retryPoll"
          >Повторить проверку статуса</Button
        >
      </div>
      <p v-else-if="requestError" class="error">{{ requestError }}</p>
      <Button
        v-if="result?.status === 'FAILED_FINAL'"
        type="button"
        @click="startNewAttempt"
        >Новая попытка</Button
      >
      <div v-else-if="result" class="success">
        <p>
          <strong>Видео принято.</strong> Проект «{{ result.name }}» создан.
        </p>
        <dl>
          <div>
            <dt>Статус</dt>
            <dd>
              {{
                result.status === "SOURCE_READY"
                  ? "Исходник готов"
                  : result.status === "SOURCE_PENDING"
                    ? "Обрабатывается"
                    : "Ошибка загрузки"
              }}
            </dd>
          </div>
          <div>
            <dt>Файл</dt>
            <dd>{{ result.source.originalFilename }}</dd>
          </div>
          <div>
            <dt>Размер</dt>
            <dd>{{ result.source.sizeBytes }} байт</dd>
          </div>
        </dl>
        <NuxtLink
          v-if="result.status === 'SOURCE_READY'"
          class="cut-link"
          :to="{ path: '/cuts', query: { projectId: result.id } }"
          >Открыть нарезку и задать таймкоды</NuxtLink
        >
        <p v-if="result.status === 'SOURCE_READY'" class="cut-help">
          На следующем экране добавь несколько пар таймкодов «начало — конец».
          Для каждой пары будет создан отдельный MP4 для скачивания.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card {
  margin-top: 1.75rem;
  padding: 1.5rem;
  background: var(--cf-surface);
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  box-shadow: var(--cf-shadow-sm);
}
.card-header {
  display: flex;
  gap: 0.9rem;
  align-items: flex-start;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--cf-border);
}
.card-header p {
  margin: 0.3rem 0 0;
  color: var(--cf-text-muted);
}
.step-number {
  display: grid;
  flex: 0 0 2.5rem;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  border-radius: 0.7rem;
  background: var(--cf-brand-soft);
  color: var(--cf-brand-strong);
  font-size: 0.75rem;
  font-weight: 800;
}
h2 {
  margin: 0;
  font-size: 1.15rem;
  letter-spacing: -0.015em;
}
.field {
  max-width: 48rem;
  margin-top: 1.35rem;
}
label {
  display: block;
  font-size: 0.82rem;
  font-weight: 700;
}
input:not([type="checkbox"]) {
  box-sizing: border-box;
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  min-height: var(--cf-control-height);
  padding: 0.7rem;
  border: 1px solid var(--cf-border-strong);
  border-radius: var(--cf-radius-sm);
  background: var(--cf-surface);
  color: var(--cf-text);
  font: inherit;
}
input[type="file"] {
  padding: 0.45rem;
  background: var(--cf-surface-subtle);
}
input[type="file"]::file-selector-button {
  margin-right: 0.75rem;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--cf-border-strong);
  border-radius: 0.45rem;
  background: var(--cf-surface);
  color: var(--cf-text);
  font-weight: 700;
  cursor: pointer;
}
input:focus-visible {
  border-color: var(--cf-brand);
  outline: 3px solid rgb(79 95 215 / 0.15);
}
.help,
.error {
  margin: 0.4rem 0 0;
  font-size: 0.9rem;
}
.help {
  color: var(--cf-text-muted);
}
.error {
  color: var(--cf-danger);
}
.checkbox-row {
  display: flex;
  gap: 0.7rem;
  margin-top: 1.5rem;
  align-items: flex-start;
  font-weight: 500;
}
.checkbox-row input {
  margin-top: 0.25rem;
}
.actions {
  margin-top: 1.5rem;
}
.status {
  min-height: 1.5rem;
  margin-top: 1.25rem;
}
.upload-progress {
  margin-top: 0.75rem;
}
.upload-progress progress {
  display: block;
  width: min(100%, 32rem);
  height: 1.25rem;
}
.upload-progress p,
.cut-help {
  margin: 0.45rem 0 0;
}
.cut-help {
  color: var(--cf-text-muted);
}
.success {
  padding: 1rem;
  background: var(--cf-success-soft);
  border-radius: var(--cf-radius-md);
}
.success p {
  margin-top: 0;
}
dl {
  margin-bottom: 0;
}
dl div {
  display: grid;
  grid-template-columns: 7rem 1fr;
  gap: 0.5rem;
}
dt {
  color: var(--cf-text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
