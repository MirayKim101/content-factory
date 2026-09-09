<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, ref, watch } from "vue";

import {
  clearActiveAttempt,
  loadActiveAttempt,
  type ActiveAttempt,
} from "~/features/upload-source/model/active-attempt-storage";
import { useSourceUpload } from "~/features/upload-source/model/use-source-upload";
import { loadLastSourceGate } from "~/features/upload-source/model/last-source-gate-storage";
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
  restoreLastSource,
  confirmAuthorization,
  isAuthorizing,
  authorizationError,
} = upload;
const recoveredAttempt = ref<ActiveAttempt | null>(null);
const recoveryMessage = ref<string | null>(null);
const recoveredFile = ref<File | null>(null);
const authorizationConfirmed = ref(false);
watch(
  () =>
    result.value
      ? `${result.value.id}:${result.value.authorization.sourceVersion}:${result.value.authorization.sourceSha256}`
      : null,
  () => {
    authorizationConfirmed.value = false;
  },
);
const recoveryLocksForm = computed(() => recoveredAttempt.value !== null);
const canRetryRecoveredUpload = computed(
  () =>
    recoveredAttempt.value?.status === "SENDING" &&
    recoveredFile.value !== null,
);
onMounted(() => {
  recoveredAttempt.value = loadActiveAttempt();
  const lastProjectId = loadLastSourceGate();
  if (lastProjectId) void restoreLastSource(lastProjectId);
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
  const units = ["КиБ", "МиБ", "ГиБ", "ТиБ"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 1 ? 0 : 1)} ${units[exponent - 1]}`;
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} с`;
  return `${Math.ceil(seconds / 60)} мин`;
}
</script>

<template>
  <section class="card" aria-labelledby="source-upload-title">
    <h2 id="source-upload-title">Исходный файл</h2>
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
        <label for="source-file">MP4-файл</label
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
          Пока доступна только ручная загрузка MP4.
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
      <template v-if="isSending">
        <progress
          v-if="uploadProgress && uploadProgress.percent !== null"
          aria-label="Прогресс отправки файла"
          :value="uploadProgress.percent"
          max="100"
        >
          {{ Math.round(uploadProgress.percent) }}%
        </progress>
        <progress v-else aria-label="Отправка файла: прогресс неизвестен" />
        <p v-if="uploadProgress">
          Передано {{ formatBytes(uploadProgress.uploadedBytes)
          }}<template v-if="uploadProgress.totalBytes !== null">
            из {{ formatBytes(uploadProgress.totalBytes) }} ({{
              Math.round(uploadProgress.percent ?? 0)
            }}%)</template
          >.
        </p>
        <p v-if="uploadProgress && uploadProgress.bytesPerSecond !== null">
          Примерно {{ formatBytes(uploadProgress.bytesPerSecond) }}/с<template
            v-if="uploadProgress.etaSeconds !== null"
            >, осталось примерно
            {{ formatDuration(uploadProgress.etaSeconds) }}</template
          >.
        </p>
        <p v-else>Скорость и оставшееся время будут показаны после замера.</p>
      </template>
      <div v-else-if="isFinalizing || pollError">
        <p>Файл передан. Сервер проверяет и сохраняет загруженный файл.</p>
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
        <div class="authorization" aria-live="polite">
          <template v-if="result.authorization.status === 'CLEARED'">
            <p><strong>Права на эту версию подтверждены.</strong></p>
            <p>
              Версия {{ result.authorization.sourceVersion }}, SHA-256
              {{ result.authorization.sourceSha256 }}.
            </p>
            <p v-if="result.authorization.confirmedAt">
              Подтверждено {{ result.authorization.confirmedAt }} по декларации
              {{ result.authorization.declarationVersion }}.
            </p>
          </template>
          <template v-else>
            <p><strong>Проверка прав ожидается.</strong></p>
            <p>
              Подтверждение относится только к версии
              {{ result.authorization.sourceVersion }} с SHA-256
              {{ result.authorization.sourceSha256 }}.
            </p>
            <label class="checkbox-row" for="source-rights-confirmed">
              <input
                id="source-rights-confirmed"
                v-model="authorizationConfirmed"
                type="checkbox"
              />
              <span
                >Подтверждаю права на использование именно этой версии.</span
              >
            </label>
            <Button
              type="button"
              :loading="isAuthorizing"
              :disabled="isAuthorizing || !authorizationConfirmed"
              @click="confirmAuthorization"
              >Подтвердить права</Button
            >
            <p v-if="authorizationError" class="error">
              {{ authorizationError }}
            </p>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card {
  margin-top: 2.5rem;
  padding: 1.5rem;
  background: #fff;
  border: 1px solid #d9e0d8;
  border-radius: 1rem;
  box-shadow: 0 1rem 3rem rgb(24 34 29 / 7%);
}
h2 {
  margin-top: 0;
  font-size: 1.4rem;
}
.field {
  margin-top: 1.25rem;
}
label {
  display: block;
  font-weight: 650;
}
input:not([type="checkbox"]) {
  box-sizing: border-box;
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.7rem;
  border: 1px solid #9ba99e;
  border-radius: 0.5rem;
  font: inherit;
}
.help,
.error {
  margin: 0.4rem 0 0;
  font-size: 0.9rem;
}
.help {
  color: #526159;
}
.error {
  color: #a61b1b;
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
button {
  padding: 0.75rem 1rem;
  color: white;
  background: #234d35;
  border: 0;
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.status {
  min-height: 1.5rem;
  margin-top: 1.25rem;
}
.success {
  padding: 1rem;
  background: #eaf6ed;
  border-radius: 0.5rem;
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
  color: #526159;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
