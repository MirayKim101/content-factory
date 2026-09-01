<script setup lang="ts">
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
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
      <label class="checkbox-row" for="rights-confirmed"
        ><Checkbox
          input-id="rights-confirmed"
          binary
          :model-value="draft.rightsConfirmed"
          :disabled="isSubmitting || recoveryLocksForm"
          :aria-invalid="Boolean(errors.rightsConfirmed)"
          aria-describedby="rights-confirmed-error"
          @update:model-value="updateDraft({ rightsConfirmed: $event })"
        /><span
          >Подтверждаю, что у меня есть права на загрузку этого видео.</span
        ></label
      >
      <p
        v-if="errors.rightsConfirmed"
        id="rights-confirmed-error"
        class="error"
      >
        {{ errors.rightsConfirmed }}
      </p>
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
