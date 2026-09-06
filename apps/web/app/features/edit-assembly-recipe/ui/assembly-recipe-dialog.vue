<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { computed, reactive, ref, watch } from "vue";

import {
  createAssemblyRecipePayload,
  emptyBannerDraft,
  emptyAssemblyRecipeForm,
  positions,
  recipeToForm,
  type AssemblyRecipeForm,
} from "~/features/edit-assembly-recipe/model/assembly-recipe-form";
import {
  clearAssemblyRecipeAttempt,
  loadAssemblyRecipeAttempt,
  saveAssemblyRecipeAttempt,
} from "~/features/edit-assembly-recipe/model/active-assembly-recipe-attempt-storage";
import {
  idempotencyForAssemblyRecipeSave,
  type AssemblyRecipeSaveAttempt,
} from "~/features/edit-assembly-recipe/model/save-identity";
import {
  clearAssemblyRenderAttempt,
  loadAssemblyRenderAttempt,
  saveAssemblyRenderAttempt,
  type AssemblyRenderAttempt,
} from "~/features/create-assembly-render/model/active-assembly-render-attempt-storage";
import {
  AssemblyRecipesApiError,
  createAssemblyRecipesApi,
  type AssemblyRecipe,
  type SaveAssemblyRecipe,
} from "~/shared/api/assembly-recipes";
import {
  AssemblyRendersApiError,
  createAssemblyRendersApi,
  type AssemblyRender,
} from "~/shared/api/assembly-renders";
import { createMontageAssetsApi } from "~/shared/api/montage-assets";
import { formatDisplayTimecode } from "~/shared/lib/timecode";

const props = defineProps<{
  visible: boolean;
  projectId: string;
  jobId: string;
  filename: string;
  cutDurationMs: number;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  "assembly-render-created": [render: AssemblyRender];
}>();
const config = useRuntimeConfig();
const recipesApi = createAssemblyRecipesApi(config.public.apiBasePath);
const rendersApi = createAssemblyRendersApi(config.public.apiBasePath);
const montageApi = createMontageAssetsApi({
  apiBasePath: config.public.apiBasePath,
});
const queryClient = useQueryClient();
const form = reactive<AssemblyRecipeForm>(emptyAssemblyRecipeForm());
const serverRevision = ref(0);
const loadedFingerprint = ref("");
const loadedIdentity = ref<string>();
const reloadArmed = ref(false);
const formError = ref<string>();
const saveError = ref<string>();
const success = ref<string>();
const saveAttempt = ref<AssemblyRecipeSaveAttempt>();
const renderAttempt = ref<AssemblyRenderAttempt>();
const renderError = ref<string>();
const renderSuccess = ref<string>();

const recipe = useQuery({
  queryKey: computed(() => ["assembly-recipe", props.jobId]),
  queryFn: () => recipesApi.get(props.jobId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: false,
});
const assets = useQuery({
  queryKey: computed(() => ["montage-assets", props.projectId]),
  queryFn: () => montageApi.list(props.projectId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: 1,
});
const renders = useQuery({
  queryKey: computed(() => ["assembly-renders", props.projectId]),
  queryFn: () => rendersApi.list(props.projectId),
  enabled: computed(() => props.visible),
  refetchOnMount: "always",
  retry: false,
});
const hydrationReady = computed(
  () =>
    recipe.isFetchedAfterMount.value &&
    assets.isFetchedAfterMount.value &&
    renders.isFetchedAfterMount.value,
);
const isLoading = computed(
  () =>
    props.visible &&
    !hydrationReady.value &&
    (recipe.isFetching.value ||
      assets.isFetching.value ||
      renders.isFetching.value),
);
const renderListLoading = computed(
  () =>
    props.visible &&
    !renders.isFetchedAfterMount.value &&
    renders.isFetching.value,
);
const renderLaunchReady = computed(
  () =>
    renders.isSuccess.value &&
    renders.isFetchedAfterMount.value &&
    !renders.isFetching.value,
);
const recipeLaunchReady = computed(
  () =>
    recipe.isSuccess.value &&
    recipe.isFetchedAfterMount.value &&
    !recipe.isFetching.value,
);
const readyAssets = computed(() =>
  (assets.data.value ?? []).filter((asset) => asset.status === "READY"),
);
const introAssets = computed(() =>
  readyAssets.value.filter((asset) => asset.kind === "INTRO"),
);
const outroAssets = computed(() =>
  readyAssets.value.filter((asset) => asset.kind === "OUTRO"),
);
const advertisementAssets = computed(() =>
  readyAssets.value.filter((asset) => asset.kind === "ADVERTISEMENT"),
);
const bannerAssets = computed(() =>
  readyAssets.value.filter((asset) => asset.kind === "BANNER"),
);
const existingRenderForCurrentRecipe = computed(() => {
  const revision = recipe.data.value?.revision.revision;
  if (!revision) return undefined;
  return (renders.data.value ?? []).find(
    (item) =>
      item.cutPipelineJobId === props.jobId && item.recipeRevision === revision,
  );
});
const renderAlreadyRequested = computed(() => {
  const state = existingRenderForCurrentRecipe.value?.job.state;
  return (
    state === "QUEUED" ||
    state === "PROCESSING" ||
    state === "RETRY_WAIT" ||
    state === "READY"
  );
});
const renderTerminalMessage = computed(() => {
  if (existingRenderForCurrentRecipe.value?.job.state !== "FAILED_FINAL")
    return undefined;
  return "Сборка этой версии рецепта завершилась ошибкой. Измените рецепт, сохраните новую revision и только затем запустите новую сборку.";
});

function currentIdentity(): string {
  return `${props.projectId}:${props.jobId}`;
}
function formFingerprint(): string {
  return JSON.stringify({
    introAssetId: form.introAssetId,
    outroAssetId: form.outroAssetId,
    advertisementAssetId: form.advertisementAssetId,
    advertisementInsertAtText: form.advertisementInsertAtText,
    banners: form.banners,
    ctaText: form.ctaText,
    ctaStartText: form.ctaStartText,
    ctaEndText: form.ctaEndText,
    ctaPosition: form.ctaPosition,
  });
}
const hasUnsavedChanges = computed(
  () =>
    Boolean(loadedFingerprint.value) &&
    formFingerprint() !== loadedFingerprint.value,
);
function loadRecipe(value: AssemblyRecipe | undefined): void {
  Object.assign(form, recipeToForm(value));
  serverRevision.value = value?.revision.revision ?? 0;
  loadedFingerprint.value = formFingerprint();
  reloadArmed.value = false;
}
watch(
  [recipe.data, hydrationReady, () => props.visible],
  ([value, ready, visible]) => {
    const identity = currentIdentity();
    if (visible && ready && loadedIdentity.value !== identity) {
      loadRecipe(value);
      loadedIdentity.value = identity;
    }
  },
  { immediate: true },
);
watch(
  () => [props.visible, props.projectId, props.jobId],
  ([visible]) => {
    if (!visible) {
      Object.assign(form, emptyAssemblyRecipeForm());
      serverRevision.value = 0;
      loadedFingerprint.value = "";
      loadedIdentity.value = undefined;
      reloadArmed.value = false;
      formError.value = undefined;
      saveError.value = undefined;
      success.value = undefined;
      saveAttempt.value = undefined;
      renderAttempt.value = undefined;
      renderError.value = undefined;
      renderSuccess.value = undefined;
    }
  },
);

function addBanner(): void {
  if (form.banners.length >= 8) return;
  form.banners.push(emptyBannerDraft());
  formError.value = undefined;
}
function removeBanner(index: number): void {
  form.banners.splice(index, 1);
  formError.value = undefined;
}
function clearAdvertisement(): void {
  form.advertisementAssetId = null;
  form.advertisementInsertAtText = "";
  form.advertisementInsertAtBaselineText = undefined;
  form.advertisementInsertAtBaselineMs = undefined;
}
function clearCta(): void {
  form.ctaText = "";
  form.ctaStartText = "";
  form.ctaEndText = "";
  form.ctaStartBaselineText = undefined;
  form.ctaStartBaselineMs = undefined;
  form.ctaEndBaselineText = undefined;
  form.ctaEndBaselineMs = undefined;
  form.ctaPosition = "BOTTOM_LEFT";
}

interface SaveRequest {
  identity: string;
  projectId: string;
  jobId: string;
  body: SaveAssemblyRecipe;
  idempotencyKey: string;
}
function requestSave(): void {
  if (save.isPending.value || assets.data.value === undefined) return;
  const result = createAssemblyRecipePayload(
    form,
    serverRevision.value,
    props.cutDurationMs,
    assets.data.value,
  );
  if (!result.payload) {
    formError.value = result.error;
    return;
  }
  formError.value = undefined;
  const recoveredAttempt = loadAssemblyRecipeAttempt(props.jobId);
  saveAttempt.value = idempotencyForAssemblyRecipeSave(
    saveAttempt.value ?? recoveredAttempt,
    result.payload,
    () => crypto.randomUUID(),
  );
  saveAssemblyRecipeAttempt(props.jobId, saveAttempt.value);
  save.mutate({
    identity: currentIdentity(),
    projectId: props.projectId,
    jobId: props.jobId,
    body: result.payload,
    idempotencyKey: saveAttempt.value.key,
  });
}
const save = useMutation({
  mutationFn: (request: SaveRequest) =>
    recipesApi.save(request.jobId, request.body, request.idempotencyKey),
  onSuccess: (value, request) => {
    if (request.identity !== currentIdentity()) return;
    queryClient.setQueryData<AssemblyRecipe>(
      ["assembly-recipe", request.jobId],
      value,
    );
    loadRecipe(value);
    clearAssemblyRecipeAttempt(request.jobId);
    saveAttempt.value = undefined;
    saveError.value = undefined;
    success.value = `Сохранён монтажный рецепт revision ${value.revision.revision}.`;
  },
  onError: (error, request) => {
    if (request.identity !== currentIdentity()) return;
    if (error instanceof AssemblyRecipesApiError && error.status === 409) {
      saveError.value =
        "Конфликт revision: текущий ввод сохранён в форме. Загрузите сохранённую версию, затем повторите свою правку.";
      return;
    }
    saveError.value =
      error instanceof Error
        ? error.message
        : "Не удалось сохранить монтажный рецепт.";
  },
});

interface RenderRequest {
  identity: string;
  jobId: string;
  recipeRevision: number;
  idempotencyKey: string;
}
function requestRender(): void {
  const savedRecipe = recipe.data.value;
  if (
    !savedRecipe ||
    !recipeLaunchReady.value ||
    !renderLaunchReady.value ||
    existingRenderForCurrentRecipe.value ||
    render.isPending.value ||
    save.isPending.value
  ) {
    if (renderTerminalMessage.value)
      renderError.value = renderTerminalMessage.value;
    return;
  }
  const revision = savedRecipe.revision.revision;
  const recovered = loadAssemblyRenderAttempt(props.jobId);
  renderAttempt.value =
    renderAttempt.value?.recipeRevision === revision
      ? renderAttempt.value
      : recovered?.recipeRevision === revision
        ? recovered
        : {
            recipeRevision: revision,
            key: `horizontal-assembly-${crypto.randomUUID()}`,
          };
  saveAssemblyRenderAttempt(props.jobId, renderAttempt.value);
  renderError.value = undefined;
  render.mutate({
    identity: currentIdentity(),
    jobId: props.jobId,
    recipeRevision: revision,
    idempotencyKey: renderAttempt.value.key,
  });
}
const render = useMutation({
  mutationFn: (request: RenderRequest) =>
    rendersApi.create(
      request.jobId,
      request.recipeRevision,
      request.idempotencyKey,
    ),
  onSuccess: (value, request) => {
    if (request.identity !== currentIdentity()) return;
    clearAssemblyRenderAttempt(request.jobId);
    renderAttempt.value = undefined;
    renderError.value = undefined;
    renderSuccess.value =
      value.job.state === "FAILED_FINAL"
        ? undefined
        : value.job.state === "READY"
          ? "Эта версия уже собрана. Готовое видео доступно на карточке."
          : "Сборка поставлена в очередь. Прогресс виден на карточке видео.";
    if (value.job.state === "FAILED_FINAL") {
      renderError.value =
        "Сборка этой версии рецепта завершилась ошибкой. Измените рецепт, сохраните новую revision и только затем запустите новую сборку.";
    }
    queryClient.setQueryData<AssemblyRender[]>(
      ["assembly-renders", props.projectId],
      (current) => {
        const items = current ?? [];
        return [value, ...items.filter((item) => item.id !== value.id)];
      },
    );
    void queryClient.invalidateQueries({
      queryKey: ["assembly-renders", props.projectId],
    });
    emit("assembly-render-created", value);
  },
  onError: (error, request) => {
    if (request.identity !== currentIdentity()) return;
    renderError.value =
      error instanceof AssemblyRendersApiError && error.code === "NETWORK_ERROR"
        ? "Неизвестно, получил ли сервер запрос. Нажмите «Собрать готовое видео» ещё раз: будет использован тот же ключ без дубля."
        : error instanceof Error
          ? error.message
          : "Не удалось поставить сборку в очередь.";
  },
});
function reloadSaved(): void {
  if (hasUnsavedChanges.value && !reloadArmed.value) {
    reloadArmed.value = true;
    saveError.value =
      "Есть несохранённые изменения. Нажмите «Загрузить сохранённую версию» ещё раз, чтобы заменить форму данными сервера.";
    return;
  }
  const identity = currentIdentity();
  void Promise.all([
    recipe.refetch(),
    assets.refetch(),
    renders.refetch(),
  ]).then(([freshRecipe]) => {
    if (identity !== currentIdentity()) return;
    loadRecipe(freshRecipe.data);
    saveError.value = undefined;
    success.value = undefined;
  });
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :style="{ width: 'min(48rem, calc(100vw - 2rem))' }"
    :pt="{
      root: { class: 'assembly-dialog-root' },
      mask: { class: 'assembly-dialog-mask' },
      header: { class: 'assembly-dialog-header' },
      title: { class: 'assembly-dialog-title' },
      content: { class: 'assembly-dialog-body' },
    }"
    :header="`Монтаж · ${filename}`"
    @update:visible="emit('update:visible', $event)"
  >
    <section
      class="assembly-dialog"
      :aria-busy="isLoading || save.isPending.value || render.isPending.value"
    >
      <p v-if="isLoading" role="status">
        Загружаем сохранённый рецепт и готовые материалы…
      </p>
      <template v-else>
        <p class="cut-duration">
          Длительность нарезки: {{ formatDisplayTimecode(cutDurationMs) }}.
        </p>
        <p
          v-if="recipe.isError.value || assets.isError.value"
          class="error"
          role="alert"
        >
          Не удалось загрузить рецепт или монтажные материалы.
          <Button
            label="Повторить загрузку"
            severity="secondary"
            @click="reloadSaved"
          />
        </p>
        <p v-if="renderListLoading" role="status">
          Проверяем сохранённые сборки этого рецепта…
        </p>
        <p v-else-if="renders.isError.value" class="error" role="alert">
          Не удалось проверить сохранённые сборки. Запуск заблокирован, пока
          список не будет загружен.
          <Button
            label="Повторить проверку сборок"
            severity="secondary"
            @click="renders.refetch()"
          />
        </p>
        <p v-if="renderTerminalMessage" class="error" role="status">
          {{ renderTerminalMessage }}
        </p>
        <form @submit.prevent="requestSave">
          <fieldset
            class="assembly-fields"
            :disabled="save.isPending.value || assets.data.value === undefined"
          >
            <section class="asset-row" aria-labelledby="intro-label">
              <label id="intro-label" for="assembly-intro">Вступление</label>
              <Select
                input-id="assembly-intro"
                v-model="form.introAssetId"
                :options="introAssets"
                option-label="originalFilename"
                option-value="id"
                :show-clear="true"
                placeholder="Без вступления"
              />
            </section>
            <section class="asset-row" aria-labelledby="outro-label">
              <label id="outro-label" for="assembly-outro">Завершение</label>
              <Select
                input-id="assembly-outro"
                v-model="form.outroAssetId"
                :options="outroAssets"
                option-label="originalFilename"
                option-value="id"
                :show-clear="true"
                placeholder="Без завершения"
              />
            </section>
            <section
              class="asset-row advertisement"
              aria-labelledby="advertisement-label"
            >
              <label id="advertisement-label" for="assembly-advertisement"
                >Реклама</label
              >
              <Select
                input-id="assembly-advertisement"
                v-model="form.advertisementAssetId"
                :options="advertisementAssets"
                option-label="originalFilename"
                option-value="id"
                :show-clear="true"
                placeholder="Без рекламы"
                @update:model-value="
                  (value) => {
                    if (!value) clearAdvertisement();
                  }
                "
              />
              <label v-if="form.advertisementAssetId" for="assembly-ad-insert"
                >Вставить в</label
              >
              <InputText
                v-if="form.advertisementAssetId"
                id="assembly-ad-insert"
                v-model="form.advertisementInsertAtText"
                inputmode="numeric"
                placeholder="00:15:00"
              />
              <Button
                v-if="form.advertisementAssetId"
                type="button"
                label="Убрать рекламу"
                severity="secondary"
                outlined
                @click="clearAdvertisement"
              />
            </section>

            <section class="overlays" aria-labelledby="banners-title">
              <div class="section-heading">
                <div>
                  <h2 id="banners-title">Баннеры</h2>
                  <p>Показываются в таймлайне основной нарезки.</p>
                </div>
                <Button
                  type="button"
                  label="Добавить баннер"
                  severity="secondary"
                  :disabled="form.banners.length >= 8"
                  @click="addBanner"
                />
              </div>
              <article
                v-for="(banner, index) in form.banners"
                :key="banner.clientItemId"
                class="banner-row"
              >
                <strong>Баннер {{ index + 1 }}</strong>
                <Select
                  v-model="banner.assetId"
                  :options="bannerAssets"
                  option-label="originalFilename"
                  option-value="id"
                  placeholder="Выберите готовый баннер"
                />
                <label
                  >С
                  <InputText
                    v-model="banner.startText"
                    inputmode="numeric"
                    placeholder="00:00:00"
                  />
                </label>
                <label
                  >До
                  <InputText
                    v-model="banner.endText"
                    inputmode="numeric"
                    placeholder="00:00:10"
                  />
                </label>
                <Select
                  v-model="banner.position"
                  :options="positions"
                  option-label="label"
                  option-value="value"
                />
                <Button
                  type="button"
                  label="Убрать"
                  severity="secondary"
                  outlined
                  @click="removeBanner(index)"
                />
              </article>
              <p v-if="!form.banners.length" class="empty">
                Баннеры не добавлены.
              </p>
            </section>

            <section class="overlays" aria-labelledby="cta-title">
              <div class="section-heading">
                <div>
                  <h2 id="cta-title">CTA</h2>
                  <p>Один текстовый призыв к действию.</p>
                </div>
                <Button
                  v-if="form.ctaText || form.ctaStartText || form.ctaEndText"
                  type="button"
                  label="Очистить CTA"
                  severity="secondary"
                  outlined
                  @click="clearCta"
                />
              </div>
              <div class="cta-fields">
                <label
                  >Текст
                  <InputText
                    v-model="form.ctaText"
                    maxlength="120"
                    placeholder="Смотрите стрим на Twitch"
                  />
                </label>
                <label
                  >С
                  <InputText
                    v-model="form.ctaStartText"
                    inputmode="numeric"
                    placeholder="00:00:30"
                  />
                </label>
                <label
                  >До
                  <InputText
                    v-model="form.ctaEndText"
                    inputmode="numeric"
                    placeholder="00:00:45"
                  />
                </label>
                <label
                  >Позиция
                  <Select
                    v-model="form.ctaPosition"
                    :options="positions"
                    option-label="label"
                    option-value="value"
                  />
                </label>
              </div>
            </section>
          </fieldset>
          <p v-if="formError" class="error" role="alert">{{ formError }}</p>
          <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
          <p v-if="success" class="success" role="status">{{ success }}</p>
          <p v-if="renderError" class="error" role="alert">{{ renderError }}</p>
          <p v-if="renderSuccess" class="success" role="status">
            {{ renderSuccess }}
          </p>
          <div class="actions">
            <Button
              type="button"
              label="Загрузить сохранённую версию"
              severity="secondary"
              outlined
              @click="reloadSaved"
            />
            <Button
              type="submit"
              :label="save.isPending.value ? 'Сохраняем…' : 'Сохранить рецепт'"
              :disabled="
                assets.data.value === undefined || save.isPending.value
              "
            />
            <Button
              type="button"
              label="Собрать готовое видео"
              :loading="render.isPending.value"
              :disabled="
                !recipe.data.value ||
                !recipeLaunchReady ||
                hasUnsavedChanges ||
                renderAlreadyRequested ||
                Boolean(renderTerminalMessage) ||
                !renderLaunchReady ||
                save.isPending.value ||
                render.isPending.value
              "
              @click="requestRender"
            />
          </div>
        </form>
      </template>
    </section>
  </Dialog>
</template>

<style scoped>
.assembly-dialog {
  display: grid;
  gap: 1rem;
}
.cut-duration,
.section-heading p,
.empty {
  margin: 0;
  color: #65736b;
}
.assembly-fields,
.overlays {
  display: grid;
  gap: 0.85rem;
  min-width: 0;
}
.assembly-fields {
  border: 0;
  margin: 0;
  padding: 0;
}
.asset-row {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 0.55rem 0.75rem;
  align-items: center;
}
.advertisement {
  grid-template-columns: 9rem minmax(0, 1fr) auto auto;
}
.overlays {
  border-top: 1px solid #d5ddd7;
  padding-top: 1rem;
}
.section-heading,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.section-heading h2 {
  margin: 0;
  font-size: 1rem;
}
.banner-row {
  display: grid;
  grid-template-columns: 5.5rem minmax(10rem, 1fr) 6.5rem 6.5rem 10rem auto;
  gap: 0.55rem;
  align-items: end;
  padding: 0.75rem;
  border: 1px solid #d5ddd7;
  border-radius: 0.6rem;
  background: #f8faf8;
}
.banner-row > label,
.cta-fields > label {
  display: grid;
  gap: 0.3rem;
  font-weight: 600;
}
.cta-fields {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) 6.5rem 6.5rem 10rem;
  gap: 0.55rem;
  align-items: end;
}
.error {
  color: #991b1b;
}
.success {
  color: #1d6a40;
}
.actions {
  border-top: 1px solid #d5ddd7;
  padding-top: 1rem;
}
</style>

<style>
/* PrimeVue teleports dialogs; keep this editor above cards and within viewport. */
.assembly-dialog-root {
  position: relative;
  z-index: 1101;
  max-height: calc(100vh - 2rem);
  overflow: hidden;
  border: 1px solid #d9e0d8;
  border-radius: 0.875rem;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 0.28);
}
.assembly-dialog-header {
  padding: 0.875rem 1rem;
  border-bottom: 1px solid #d9e0d8;
}
.assembly-dialog-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assembly-dialog-body {
  max-height: calc(100vh - 8rem);
  overflow: auto;
  padding: 1rem;
}
.assembly-dialog-mask {
  z-index: 1100 !important;
  background: rgb(15 23 42 / 0.48);
}
</style>
