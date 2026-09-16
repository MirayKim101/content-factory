<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import {
  computed,
  reactive,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
} from "vue";
import {
  profileFormSchema,
  referenceAuthorizationSchema,
} from "~/features/edit-creator-context/model/forms";
import {
  clearCreatorOperationKey,
  creatorOperationKey,
  creatorReferenceFingerprint,
} from "~/features/edit-creator-context/model/attempt-storage";
import {
  createCreatorContextApi,
  CreatorContextApiError,
  type CreatorProfile,
  type ProfileInput,
  type ReferenceAuthorizationInput,
  type DefaultReferenceInput,
} from "~/shared/api/creator-context";

const config = useRuntimeConfig();
const api = createCreatorContextApi(config.public.apiBasePath);
const client = useQueryClient();
const enabled = computed(() => config.public.aiContextEnabled === true);
const selectedId = ref<string>();
const createMode = ref(false);
const error = ref<string>();
const success = ref<string>();
const conflict = ref(false);
const conflictingProfileId = ref<string>();
const file = ref<File>();
const preparingUpload = ref(false);
let session = 0;
let alive = true;
const loadedId = ref<string>();
const baseRevision = ref(0);
const form = reactive({
  canonicalDisplayName: "",
  officialUrl: "",
  primaryLanguage: "",
  topicsText: "",
  editorialNotes: "",
  restrictionsText: "",
});
const baseline = ref(JSON.stringify(form));
const profileDirty = computed(() => JSON.stringify(form) !== baseline.value);
const emptyRights = () => ({
  basis: "",
  scope: "",
  expiresAt: "",
  externalProviderTransferAllowed: false,
  attested: false,
});
const rights = reactive<Record<string, ReturnType<typeof emptyRights>>>({});
const rightsBaseRevision = new Map<string, number>();
function rightsFor(id: string) {
  if (!rights[id]) {
    rightsBaseRevision.set(
      id,
      references.data.value?.find((asset) => asset.id === id)
        ?.currentAuthorization.revision ?? 0,
    );
    rights[id] = emptyRights();
  }
  return rights[id];
}
function hasRightsDraft(id: string) {
  return (
    !!rights[id] && JSON.stringify(rights[id]) !== JSON.stringify(emptyRights())
  );
}
const dirty = computed(
  () =>
    profileDirty.value ||
    !!file.value ||
    Object.values(rights).some(
      (value) => JSON.stringify(value) !== JSON.stringify(emptyRights()),
    ),
);
const profiles = useQuery({
  queryKey: ["creator-profiles"],
  queryFn: api.listProfiles,
  enabled,
  retry: false,
});
const detail = useQuery({
  queryKey: computed(() => ["creator-profile", selectedId.value]),
  queryFn: () => api.getProfile(selectedId.value!),
  enabled: computed(() => enabled.value && !!selectedId.value),
  retry: false,
});
const references = useQuery({
  queryKey: computed(() => ["creator-references", selectedId.value]),
  queryFn: () => api.listReferences(selectedId.value!),
  enabled: computed(() => enabled.value && !!selectedId.value),
  retry: false,
});
const historyAssetId = ref<string>();
const authorizationHistory = useQuery({
  queryKey: computed(() => [
    "creator-reference-history",
    selectedId.value,
    historyAssetId.value,
  ]),
  queryFn: () => api.getAuthorization(selectedId.value!, historyAssetId.value!),
  enabled: computed(
    () => enabled.value && !!selectedId.value && !!historyAssetId.value,
  ),
  retry: false,
});
function reset(value?: CreatorProfile) {
  const e = value?.revision.editableRevision;
  Object.assign(form, {
    canonicalDisplayName: e?.canonicalDisplayName ?? "",
    officialUrl: e?.officialUrl ?? "",
    primaryLanguage: e?.primaryLanguage ?? "",
    topicsText: e?.topics.join("\n") ?? "",
    editorialNotes: e?.editorialNotes ?? "",
    restrictionsText: e?.restrictions.join("\n") ?? "",
  });
  baseline.value = JSON.stringify(form);
  baseRevision.value = value?.currentRevision ?? 0;
  loadedId.value = value?.id;
}
watch(
  () => detail.data.value,
  (value) => {
    if (value?.id === selectedId.value && !profileDirty.value) reset(value);
  },
);
function canDiscard() {
  return (
    !dirty.value ||
    confirm("Несохранённые изменения будут потеряны. Продолжить?")
  );
}
function select(id?: string) {
  if (!canDiscard()) return;
  session++;
  historyAssetId.value = undefined;
  reset();
  file.value = undefined;
  for (const key of Object.keys(rights)) delete rights[key];
  rightsBaseRevision.clear();
  error.value = success.value = undefined;
  conflict.value = false;
  conflictingProfileId.value = undefined;
  createMode.value = !id;
  selectedId.value = id;
  const cached = id
    ? client.getQueryData<CreatorProfile>(["creator-profile", id])
    : undefined;
  if (cached) reset(cached);
}
onBeforeRouteLeave(() => canDiscard());
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  alive = false;
  session++;
  window.removeEventListener("beforeunload", beforeUnload);
});
function report(cause: unknown) {
  const e =
    cause instanceof Error
      ? cause
      : new Error("Не удалось выполнить действие.");
  conflict.value = e instanceof CreatorContextApiError && e.status === 409;
  conflictingProfileId.value =
    e instanceof CreatorContextApiError ? e.existingProfileId : undefined;
  error.value = conflictingProfileId.value
    ? "Этот URL принадлежит существующему профилю. Можно открыть его без объединения."
    : conflict.value
      ? "Данные изменились. Загрузите актуальную версию; перезапись без проверки запрещена."
      : e.message;
  success.value = undefined;
}
async function reload() {
  if (!selectedId.value || !canDiscard()) return;
  const target = selectedId.value;
  const epoch = session;
  const [result, referenceResult] = await Promise.all([
    detail.refetch(),
    references.refetch(),
  ]);
  if (!alive || epoch !== session || target !== selectedId.value) return;
  if (result.error || referenceResult.error) {
    report(result.error ?? referenceResult.error);
    return;
  }
  reset(result.data);
  file.value = undefined;
  for (const key of Object.keys(rights)) delete rights[key];
  rightsBaseRevision.clear();
  conflict.value = false;
  error.value = undefined;
}
function cacheProfile(value: CreatorProfile) {
  void client.cancelQueries({
    queryKey: ["creator-profile", value.id],
    exact: true,
  });
  client.setQueryData<CreatorProfile>(["creator-profile", value.id], (old) =>
    !old || old.currentRevision <= value.currentRevision ? value : old,
  );
}
type SaveRequest = {
  profileId?: string;
  epoch: number;
  body: ProfileInput;
  expectedRevision: number;
  key: string;
  snapshot: string;
  operation: string;
  target: string;
};
const save = useMutation({
  mutationFn: (r: SaveRequest) =>
    r.profileId
      ? api.updateProfile(
          r.profileId,
          { ...r.body, expectedRevision: r.expectedRevision },
          r.key,
        )
      : api.createProfile(r.body, r.key),
  onSuccess: (value, r) => {
    clearCreatorOperationKey(r.operation, r.target, r.key);
    cacheProfile(value);
    void client.invalidateQueries({ queryKey: ["creator-profiles"] });
    void client.invalidateQueries({
      queryKey: ["creator-reference-history", r.profileId],
    });
    if (!alive || r.epoch !== session) return;
    selectedId.value = value.id;
    createMode.value = false;
    loadedId.value = value.id;
    baseRevision.value = value.currentRevision;
    if (JSON.stringify(form) === r.snapshot) reset(value);
    else baseline.value = r.snapshot;
    error.value = undefined;
    conflict.value = false;
    success.value = `Сохранена версия ${value.currentRevision}.`;
  },
  onError: (cause, r) => {
    if (alive && r.epoch === session) report(cause);
  },
});
function submit() {
  if (
    save.isPending.value ||
    referenceAction.isPending.value ||
    preparingUpload.value ||
    (!createMode.value && loadedId.value !== selectedId.value)
  )
    return;
  const parsed = profileFormSchema.safeParse(form);
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message;
    return;
  }
  const body: ProfileInput = {
    canonicalDisplayName: parsed.data.canonicalDisplayName,
    officialUrl: parsed.data.officialUrl,
    primaryLanguage: parsed.data.primaryLanguage,
    topics: parsed.data.topicsText,
    editorialNotes: parsed.data.editorialNotes,
    restrictions: parsed.data.restrictionsText,
  };
  const profileId = createMode.value ? undefined : selectedId.value;
  const operation = profileId ? "profile-update" : "profile-create";
  const target = profileId ?? "new";
  try {
    const key = creatorOperationKey(
      operation,
      target,
      profileId ? { ...body, expectedRevision: baseRevision.value } : body,
    );
    save.mutate({
      profileId,
      epoch: session,
      body,
      expectedRevision: baseRevision.value,
      key,
      snapshot: JSON.stringify(form),
      operation,
      target,
    });
  } catch (cause) {
    report(cause);
  }
}
type ReferenceRequest = {
  epoch: number;
  profileId: string;
  key: string;
  target: string;
  operation: string;
} & (
  | { kind: "upload"; file: File }
  | {
      kind: "authorization";
      assetId: string;
      body: ReferenceAuthorizationInput;
      snapshot: string;
    }
  | { kind: "default"; body: DefaultReferenceInput }
);
const referenceAction = useMutation({
  mutationFn: async (r: ReferenceRequest) => {
    if (r.kind === "upload") {
      await api.uploadReference(r.profileId, r.file, r.key);
      return { kind: "upload" as const };
    }
    if (r.kind === "authorization") {
      return {
        kind: "authorization" as const,
        detail: await api.updateAuthorization(
          r.profileId,
          r.assetId,
          r.body,
          r.key,
        ),
      };
    }
    return {
      kind: "default" as const,
      profile: await api.setDefault(r.profileId, r.body, r.key),
    };
  },
  onSuccess: (value, r) => {
    clearCreatorOperationKey(r.operation, r.target, r.key);
    if (value.kind === "default") cacheProfile(value.profile);
    void client.invalidateQueries({
      queryKey: ["creator-references", r.profileId],
    });
    void client.invalidateQueries({
      queryKey: ["creator-profile", r.profileId],
    });
    void client.invalidateQueries({ queryKey: ["creator-profiles"] });
    void client.invalidateQueries({
      queryKey: ["creator-reference-history", r.profileId],
    });
    if (!alive || r.epoch !== session) return;
    if (r.kind === "upload" && file.value === r.file) file.value = undefined;
    if (r.kind === "authorization" && value.kind === "authorization") {
      if (JSON.stringify(rights[r.assetId]) === r.snapshot) {
        delete rights[r.assetId];
        rightsBaseRevision.delete(r.assetId);
      } else if (rights[r.assetId]) {
        // Only our exact successful result may advance an in-flight edited draft.
        // An unrelated later query revision must still produce a CAS conflict.
        rightsBaseRevision.set(r.assetId, value.detail.current.revision);
      }
    }
    error.value = undefined;
    conflict.value = false;
    success.value =
      r.kind === "upload"
        ? "Фото загружено. Оно не проверено и не выбрано по умолчанию."
        : r.kind === "default"
          ? "Выбор фото сохранён в новой версии профиля."
          : r.body.decision === "REVOKED"
            ? "Разрешение отозвано. Обновляем статус использования внешности."
            : "Разрешение сохранено. Фото по умолчанию выбирается отдельным действием.";
  },
  onError: (cause, r) => {
    const terminalUpload =
      r.kind === "upload" &&
      cause instanceof CreatorContextApiError &&
      cause.status === 503 &&
      (cause.code === "CREATOR_REFERENCE_STORAGE_FAILED" ||
        cause.code === "CREATOR_REFERENCE_FINALIZE_FAILED");
    // These codes now guarantee persisted FAILED_FINAL. Outcome-unknown, network,
    // generic server errors and still-in-progress responses keep the exact key.
    if (terminalUpload) clearCreatorOperationKey(r.operation, r.target, r.key);
    if (!alive || r.epoch !== session) return;
    if (terminalUpload) {
      error.value =
        "Эта загрузка завершилась ошибкой. Нажмите «Загрузить фото» ещё раз, чтобы начать новую попытку.";
      conflict.value = false;
      success.value = undefined;
    } else report(cause);
  },
});
async function upload() {
  if (
    !selectedId.value ||
    !file.value ||
    referenceAction.isPending.value ||
    save.isPending.value ||
    preparingUpload.value
  )
    return;
  const profileId = selectedId.value,
    chosen = file.value,
    epoch = session;
  preparingUpload.value = true;
  try {
    const fingerprint = await creatorReferenceFingerprint(chosen);
    if (!alive || epoch !== session || file.value !== chosen) return;
    const operation = "reference-upload",
      target = profileId;
    referenceAction.mutate({
      kind: "upload",
      file: chosen,
      profileId,
      epoch,
      operation,
      target,
      key: creatorOperationKey(operation, target, fingerprint),
    });
  } catch (cause) {
    if (alive && epoch === session) report(cause);
  } finally {
    preparingUpload.value = false;
  }
}
function updateRights(assetId: string, decision: "CLEARED" | "REVOKED") {
  if (
    !selectedId.value ||
    referenceAction.isPending.value ||
    save.isPending.value ||
    preparingUpload.value
  )
    return;
  const asset = references.data.value?.find((x) => x.id === assetId);
  if (!asset) return;
  const body: ReferenceAuthorizationInput = {
    expectedRevision:
      decision === "CLEARED"
        ? (rightsBaseRevision.get(assetId) ??
          asset.currentAuthorization.revision)
        : asset.currentAuthorization.revision,
    decision,
  };
  if (decision === "CLEARED") {
    const parsed = referenceAuthorizationSchema.safeParse(rightsFor(assetId));
    if (!parsed.success) {
      error.value =
        "Укажите основание, область и срок разрешения; подтвердите использование внешности.";
      return;
    }
    Object.assign(body, {
      declarationVersion: "creator-likeness-rights-v1",
      commercialAiImageUseAttested: true,
      basis: parsed.data.basis,
      scope: parsed.data.scope,
      expiresAt: parsed.data.expiresAt || null,
      externalProviderTransferAllowed:
        parsed.data.externalProviderTransferAllowed,
    });
  }
  const profileId = selectedId.value,
    operation = "reference-authorization",
    target = `${profileId}:${assetId}`;
  try {
    referenceAction.mutate({
      kind: "authorization",
      assetId,
      body,
      profileId,
      epoch: session,
      operation,
      target,
      key: creatorOperationKey(operation, target, body),
      snapshot: JSON.stringify(rights[assetId]),
    });
  } catch (cause) {
    report(cause);
  }
}
function setDefault(assetId?: string) {
  if (
    !selectedId.value ||
    referenceAction.isPending.value ||
    save.isPending.value ||
    preparingUpload.value ||
    !detail.data.value
  )
    return;
  if (profileDirty.value) {
    error.value =
      "Сначала сохраните изменения профиля или загрузите актуальную версию. Затем выбирайте фото по умолчанию.";
    return;
  }
  const asset = references.data.value?.find((x) => x.id === assetId);
  if (assetId && !asset) return;
  const body: DefaultReferenceInput = {
    expectedProfileRevision: detail.data.value.currentRevision,
    action: asset ? "SET" : "CLEAR",
    ...(asset
      ? {
          assetId: asset.id,
          authorizationRevisionId: asset.currentAuthorization.id,
          authorizationRevision: asset.currentAuthorization.revision,
        }
      : {}),
  };
  const profileId = selectedId.value,
    operation = "default-reference",
    target = profileId;
  try {
    referenceAction.mutate({
      kind: "default",
      body,
      profileId,
      epoch: session,
      operation,
      target,
      key: creatorOperationKey(operation, target, body),
    });
  } catch (cause) {
    report(cause);
  }
}
</script>
<template>
  <main class="workspace">
    <header>
      <p class="eyebrow">Редакторский контекст</p>
      <h1>Профили стримеров</h1>
      <p>
        Официальная ссылка идентифицирует профиль. Ни ссылка, ни права на
        исходное видео не разрешают реалистичное изображение человека.
      </p>
    </header>
    <p v-if="!enabled" class="warning" role="status">
      Редакторский контекст выключен в настройках. Ручной редакционный поток
      остаётся доступен.
    </p>
    <template v-else
      ><div class="layout">
        <section>
          <div class="row">
            <h2>Каталог</h2>
            <Button label="Создать профиль" @click="select()" />
          </div>
          <p v-if="profiles.isLoading.value" role="status">
            Загружаем профили…
          </p>
          <p v-else-if="profiles.isError.value" class="error" role="alert">
            Не удалось загрузить каталог.
            <Button
              label="Повторить загрузку каталога"
              :disabled="profiles.isFetching.value"
              @click="profiles.refetch()"
            />
          </p>
          <button
            v-for="profile in profiles.data.value"
            :key="profile.id"
            class="profile"
            type="button"
            @click="select(profile.id)"
          >
            <strong>{{ profile.canonicalDisplayName }}</strong
            ><span
              >{{ profile.primaryLanguage }} · версия
              {{ profile.currentRevision }}</span
            ><span>{{
              profile.likenessAllowed
                ? "Внешность разрешена только по выбранному фото"
                : "Реалистичное лицо запрещено"
            }}</span>
          </button>
        </section>
        <section v-if="createMode || selectedId" class="editor">
          <h2>
            {{ createMode ? "Новый профиль" : "Редактирование профиля" }}
          </h2>
          <p v-if="detail.isLoading.value" role="status">
            Загружаем полную версию профиля…
          </p>
          <p
            v-else-if="
              !createMode && (detail.isError.value || loadedId !== selectedId)
            "
            role="alert"
          >
            Не удалось загрузить полную версию профиля. Сохранение
            недоступно.<Button label="Повторить загрузку" @click="reload" />
          </p>
          <template v-else
            ><form @submit.prevent="submit">
              <fieldset
                :disabled="
                  save.isPending.value ||
                  referenceAction.isPending.value ||
                  preparingUpload
                "
                class="profile-fields"
              >
                <label
                  >Имя<InputText v-model="form.canonicalDisplayName" /></label
                ><label
                  >Официальная ссылка<InputText
                    v-model="form.officialUrl"
                    inputmode="url" /></label
                ><a
                  v-if="form.officialUrl.startsWith('https://')"
                  :href="form.officialUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Открыть официальную страницу</a
                ><label>Язык<InputText v-model="form.primaryLanguage" /></label
                ><label
                  >Темы, одна на строку<Textarea
                    v-model="form.topicsText" /></label
                ><label
                  >Личные заметки<Textarea
                    v-model="form.editorialNotes" /></label
                ><label
                  >Ограничения, одна на строку<Textarea
                    v-model="form.restrictionsText" /></label
                ><Button
                  type="submit"
                  :loading="save.isPending.value"
                  :disabled="
                    save.isPending.value ||
                    referenceAction.isPending.value ||
                    preparingUpload
                  "
                  :label="createMode ? 'Создать' : 'Сохранить новую версию'"
                />
              </fieldset>
            </form>
            <template v-if="selectedId"
              ><hr />
              <h3>Фото для использования внешности</h3>
              <p v-if="profileDirty" role="status">
                Перед выбором фото по умолчанию сохраните изменения профиля или
                загрузите актуальную версию.
              </p>
              <p v-if="detail.data.value" data-testid="likeness-status">
                {{ detail.data.value.revision.likenessPolicy }} ·
                {{
                  detail.data.value.revision.likenessUsability.usable
                    ? "Использование внешности разрешено"
                    : "Использование внешности недоступно"
                }}
                · {{ detail.data.value.revision.likenessUsability.blocker
                }}<span v-if="detail.data.value.revision.defaultReference">
                  · Фото по умолчанию:
                  {{ detail.data.value.revision.defaultReference.assetId }} /
                  версия разрешения
                  {{
                    detail.data.value.revision.defaultReference
                      .authorizationRevision
                  }}</span
                >
              </p>
              <Button
                v-if="detail.data.value?.revision.defaultReference"
                label="Убрать фото по умолчанию"
                :disabled="
                  profileDirty ||
                  referenceAction.isPending.value ||
                  save.isPending.value ||
                  preparingUpload
                "
                @click="setDefault()" />
              <p v-if="references.isError.value" role="alert">
                Не удалось загрузить фото.<Button
                  label="Повторить загрузку фото"
                  @click="references.refetch()"
                />
              </p>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0]
                " /><Button
                label="Загрузить фото"
                :disabled="
                  !file ||
                  preparingUpload ||
                  referenceAction.isPending.value ||
                  save.isPending.value
                "
                :loading="preparingUpload || referenceAction.isPending.value"
                @click="upload" />
              <article
                v-for="asset in references.data.value"
                :key="asset.id"
                class="reference"
              >
                <img
                  :src="api.referenceContentUrl(selectedId, asset.id)"
                  :alt="`Reference ${asset.originalFilename}`"
                />
                <p>
                  {{ asset.originalFilename }} · {{ asset.status }} ·
                  разрешение:
                  {{ asset.currentAuthorization.status }}
                </p>
                <Button
                  label="История разрешений"
                  @click="historyAssetId = asset.id"
                />
                <section
                  v-if="historyAssetId === asset.id"
                  aria-label="История разрешений"
                >
                  <p v-if="authorizationHistory.isLoading.value">
                    Загружаем историю…
                  </p>
                  <p
                    v-else-if="authorizationHistory.isError.value"
                    role="alert"
                  >
                    Не удалось загрузить историю.<Button
                      label="Повторить загрузку истории"
                      @click="authorizationHistory.refetch()"
                    />
                  </p>
                  <ul v-else>
                    <li
                      v-for="revision in authorizationHistory.data.value
                        ?.history"
                      :key="revision.id"
                    >
                      Версия {{ revision.revision }} · {{ revision.status }} ·
                      {{ revision.basis }} · {{ revision.scope }}
                    </li>
                  </ul>
                </section>
                <p v-if="asset.currentAuthorization.status === 'NOT_REVIEWED'">
                  Фото не проверено: использовать внешность пока нельзя.
                </p>
                <div
                  v-if="
                    asset.currentAuthorization.status !== 'CLEARED' ||
                    hasRightsDraft(asset.id)
                  "
                >
                  <label
                    >Основание<InputText
                      v-model="rightsFor(asset.id).basis" /></label
                  ><label
                    >Область разрешения<InputText
                      v-model="rightsFor(asset.id).scope" /></label
                  ><label
                    >Срок действия (необязательно)<InputText
                      v-model="rightsFor(asset.id).expiresAt"
                      placeholder="2026-12-31T00:00:00.000Z" /></label
                  ><Checkbox
                    v-model="
                      rightsFor(asset.id).externalProviderTransferAllowed
                    "
                    binary
                    :input-id="`transfer-${asset.id}`"
                  /><label :for="`transfer-${asset.id}`"
                    >Разрешаю передавать фото внешнему сервису</label
                  ><Checkbox
                    v-model="rightsFor(asset.id).attested"
                    binary
                    :input-id="`attest-${asset.id}`"
                  /><label :for="`attest-${asset.id}`"
                    >Подтверждаю коммерческое использование внешности в
                    AI-изображениях</label
                  ><Button
                    label="Подтвердить разрешение"
                    :disabled="
                      referenceAction.isPending.value ||
                      save.isPending.value ||
                      preparingUpload
                    "
                    @click="updateRights(asset.id, 'CLEARED')"
                  />
                </div>
                <Button
                  v-if="asset.currentAuthorization.status === 'CLEARED'"
                  label="Использовать по умолчанию"
                  :disabled="
                    profileDirty ||
                    referenceAction.isPending.value ||
                    save.isPending.value ||
                    preparingUpload
                  "
                  @click="setDefault(asset.id)"
                /><Button
                  v-if="asset.currentAuthorization.status === 'CLEARED'"
                  severity="danger"
                  outlined
                  label="Отозвать разрешение"
                  :disabled="
                    referenceAction.isPending.value ||
                    save.isPending.value ||
                    preparingUpload
                  "
                  @click="updateRights(asset.id, 'REVOKED')"
                /></article></template
          ></template>
        </section>
      </div>
      <p v-if="error" class="error" role="alert">
        {{ error }}
        <Button
          v-if="conflictingProfileId"
          label="Открыть существующий профиль"
          @click="select(conflictingProfileId)"
        />
        <Button
          v-if="selectedId && (conflict || detail.isError.value)"
          label="Загрузить актуальную версию"
          severity="secondary"
          @click="reload"
        />
      </p>
      <p v-if="success" role="status">{{ success }}</p></template
    >
  </main>
</template>
<style scoped>
.profile-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.workspace {
  max-width: 110rem;
  margin: auto;
  padding: 2rem;
}
.layout {
  display: grid;
  grid-template-columns: minmax(16rem, 1fr) minmax(34rem, 2fr);
  gap: 2rem;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.profile {
  display: grid;
  width: 100%;
  gap: 0.25rem;
  margin: 0.5rem 0;
  padding: 1rem;
  text-align: left;
  border: 1px solid #d5ddd7;
  background: #fff;
  border-radius: 0.5rem;
}
.editor {
  padding: 1rem;
  border: 1px solid #d5ddd7;
  border-radius: 0.75rem;
}
form,
label {
  display: grid;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
}
.reference {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
  margin-top: 1rem;
  border-top: 1px solid #d5ddd7;
}
.reference img {
  max-width: 16rem;
  max-height: 12rem;
}
.error {
  color: #991b1b;
}
.warning {
  color: #7c4a03;
}
.eyebrow {
  color: #65736b;
  font-weight: 700;
}
@media (max-width: 1023px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
