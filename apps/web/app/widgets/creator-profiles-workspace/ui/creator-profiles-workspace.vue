<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import { computed, reactive, ref, watch } from "vue";
import {
  profileFormSchema,
  referenceAuthorizationSchema,
} from "~/features/edit-creator-context/model/forms";
import {
  clearCreatorOperationKey,
  creatorOperationKey,
} from "~/features/edit-creator-context/model/attempt-storage";
import {
  createCreatorContextApi,
  CreatorContextApiError,
  type CreatorProfile,
  type ProfileInput,
} from "~/shared/api/creator-context";

const config = useRuntimeConfig();
const api = createCreatorContextApi(config.public.apiBasePath);
const client = useQueryClient();
const enabled = computed(() => config.public.aiContextEnabled === true);
const selectedId = ref<string>();
const createMode = ref(false);
const dirty = ref(false);
const error = ref<string>();
const success = ref<string>();
const file = ref<File>();
const form = reactive({
  canonicalDisplayName: "",
  officialUrl: "",
  primaryLanguage: "",
  topicsText: "",
  editorialNotes: "",
  restrictionsText: "",
});
const authorization = reactive({
  basis: "",
  scope: "",
  expiresAt: "",
  externalProviderTransferAllowed: false,
  attested: false,
});
const profiles = useQuery({
  queryKey: ["creator-profiles"],
  queryFn: api.listProfiles,
  enabled,
  retry: 1,
});
const detail = useQuery({
  queryKey: computed(() => ["creator-profile", selectedId.value]),
  queryFn: () => api.getProfile(selectedId.value!),
  enabled: computed(() => enabled.value && !!selectedId.value),
  retry: 1,
});
const references = useQuery({
  queryKey: computed(() => ["creator-references", selectedId.value]),
  queryFn: () => api.listReferences(selectedId.value!),
  enabled: computed(() => enabled.value && !!selectedId.value),
  retry: 1,
});
function reset(value?: CreatorProfile) {
  const editable = value?.revision.editableRevision;
  form.canonicalDisplayName = editable?.canonicalDisplayName ?? "";
  form.officialUrl = editable?.officialUrl ?? "";
  form.primaryLanguage = editable?.primaryLanguage ?? "";
  form.topicsText = editable?.topics.join("\n") ?? "";
  form.editorialNotes = editable?.editorialNotes ?? "";
  form.restrictionsText = editable?.restrictions.join("\n") ?? "";
  dirty.value = false;
  error.value = undefined;
}
watch(
  () => detail.data.value,
  (value) => {
    if (value && !dirty.value) reset(value);
  },
);
function payload(): ProfileInput | undefined {
  const parsed = profileFormSchema.safeParse(form);
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? "Проверьте поля профиля.";
    return;
  }
  error.value = undefined;
  return {
    canonicalDisplayName: parsed.data.canonicalDisplayName,
    officialUrl: parsed.data.officialUrl,
    primaryLanguage: parsed.data.primaryLanguage,
    topics: parsed.data.topicsText,
    editorialNotes: parsed.data.editorialNotes,
    restrictions: parsed.data.restrictionsText,
  };
}
function select(id: string) {
  if (
    dirty.value &&
    !confirm("Несохранённые изменения будут потеряны. Продолжить?")
  )
    return;
  createMode.value = false;
  selectedId.value = id;
}
const save = useMutation({
  mutationFn: (input: ProfileInput) => {
    if (createMode.value) {
      return api.createProfile(
        input,
        creatorOperationKey("profile-create", "new", input),
      );
    }
    const target = selectedId.value!;
    const body = {
      ...input,
      expectedRevision: detail.data.value!.currentRevision,
    };
    return api.updateProfile(
      target,
      body,
      creatorOperationKey("profile-update", target, body),
    );
  },
  onSuccess: async (value) => {
    clearCreatorOperationKey(
      createMode.value ? "profile-create" : "profile-update",
      createMode.value ? "new" : value.id,
    );
    selectedId.value = value.id;
    createMode.value = false;
    dirty.value = false;
    success.value = `Сохранена revision ${value.currentRevision}.`;
    client.setQueryData(["creator-profile", value.id], value);
    await client.invalidateQueries({ queryKey: ["creator-profiles"] });
    await client.invalidateQueries({
      queryKey: ["creator-references", value.id],
    });
  },
  onError: (cause) => {
    const e = cause as CreatorContextApiError;
    error.value =
      e.code === "CREATOR_PROFILE_OFFICIAL_URL_CONFLICT" && e.existingProfileId
        ? "Этот официальный URL уже принадлежит профилю. Откройте существующий профиль."
        : e.status === 409
          ? "Конфликт revision. Загрузите серверную revision и повторите сохранение."
          : e.message;
    if (e.existingProfileId) selectedId.value = e.existingProfileId;
  },
});
const upload = useMutation({
  mutationFn: () =>
    api.uploadReference(selectedId.value!, file.value!, crypto.randomUUID()),
  onSuccess: () => {
    file.value = undefined;
    success.value = "Reference загружен. Он ещё не разрешён для likeness.";
    void client.invalidateQueries({
      queryKey: ["creator-references", selectedId.value],
    });
  },
  onError: (cause) => {
    error.value = (cause as Error).message;
  },
});
const updateRights = useMutation({
  mutationFn: (asset: string) => {
    const parsed = referenceAuthorizationSchema.safeParse(authorization);
    if (!parsed.success)
      throw new Error(
        "Для разрешения подтвердите attestацию, основание и scope.",
      );
    return api.updateAuthorization(
      selectedId.value!,
      asset,
      {
        expectedRevision: references.data.value?.find((x) => x.id === asset)
          ?.currentAuthorization.revision,
        decision: "CLEARED",
        declarationVersion: "creator-likeness-rights-v1",
        commercialAiImageUseAttested: true,
        basis: parsed.data.basis,
        scope: parsed.data.scope,
        expiresAt: parsed.data.expiresAt || null,
        externalProviderTransferAllowed:
          parsed.data.externalProviderTransferAllowed,
      },
      crypto.randomUUID(),
    );
  },
  onSuccess: () => {
    success.value = "Rights revision сохранена. Выберите reference отдельно.";
    void client.invalidateQueries({
      queryKey: ["creator-references", selectedId.value],
    });
  },
  onError: (cause) => {
    error.value = (cause as Error).message;
  },
});
const setDefault = useMutation({
  mutationFn: (assetId: string) => {
    const asset = references.data.value?.find((x) => x.id === assetId);
    if (!asset) {
      throw new Error("Выбранное изображение не найдено. Обновите список.");
    }
    return api.setDefault(
      selectedId.value!,
      {
        expectedProfileRevision: detail.data.value!.currentRevision,
        action: "SET",
        assetId,
        authorizationRevisionId: asset.currentAuthorization.id,
        authorizationRevision: asset.currentAuthorization.revision,
      },
      crypto.randomUUID(),
    );
  },
  onSuccess: (value) => {
    client.setQueryData(["creator-profile", value.id], value);
    success.value = "Reference выбран по умолчанию в новой revision профиля.";
    void client.invalidateQueries({ queryKey: ["creator-profiles"] });
  },
  onError: (cause) => {
    error.value = (cause as Error).message;
  },
});
function revoke(assetId: string) {
  void api
    .updateAuthorization(
      selectedId.value!,
      assetId,
      {
        expectedRevision: references.data.value?.find((x) => x.id === assetId)
          ?.currentAuthorization.revision,
        decision: "REVOKED",
      },
      crypto.randomUUID(),
    )
    .then(() => {
      success.value = "Разрешение отозвано.";
      return client.invalidateQueries({
        queryKey: ["creator-references", selectedId.value],
      });
    })
    .catch((cause: Error) => {
      error.value = cause.message;
    });
}
</script>
<template>
  <main class="workspace">
    <header>
      <p class="eyebrow">Stage 2B · private workspace</p>
      <h1>Профили стримеров</h1>
      <p>
        Official URL подтверждает источник, но сам по себе не разрешает
        realistic likeness.
      </p>
    </header>
    <p v-if="!enabled" class="warning" role="status">
      Creator context отключён операторским флагом. Ручной редакционный поток
      остаётся доступен.
    </p>
    <template v-else
      ><div class="layout">
        <section>
          <div class="row">
            <h2>Каталог</h2>
            <Button
              label="Создать профиль"
              @click="
                createMode = true;
                selectedId = undefined;
                reset();
              "
            />
          </div>
          <p v-if="profiles.isLoading.value" role="status">
            Загружаем профили…
          </p>
          <p v-else-if="profiles.isError.value" class="error" role="alert">
            Не удалось загрузить каталог.
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
              >{{ profile.primaryLanguage }} · revision
              {{ profile.currentRevision }}</span
            ><span>{{
              profile.likenessAllowed
                ? "Likeness разрешён только с reference"
                : "Реалистичное лицо запрещено"
            }}</span>
          </button>
        </section>
        <section v-if="createMode || selectedId" class="editor">
          <h2>
            {{ createMode ? "Новый профиль" : "Private profile revision" }}
          </h2>
          <p v-if="detail.isLoading.value" role="status">
            Загружаем private revision…
          </p>
          <template v-else
            ><form
              @submit.prevent="
                () => {
                  const input = payload();
                  if (input) save.mutate(input);
                }
              "
            >
              <label
                >Имя<InputText
                  v-model="form.canonicalDisplayName"
                  @input="dirty = true" /></label
              ><label
                >Official URL<InputText
                  v-model="form.officialUrl"
                  inputmode="url"
                  @input="dirty = true" /></label
              ><a
                v-if="form.officialUrl.startsWith('https://')"
                :href="form.officialUrl"
                target="_blank"
                rel="noopener noreferrer"
                >Открыть official URL</a
              ><label
                >Язык<InputText
                  v-model="form.primaryLanguage"
                  @input="dirty = true" /></label
              ><label
                >Темы, одна на строку<Textarea
                  v-model="form.topicsText"
                  @input="dirty = true" /></label
              ><label
                >Private notes<Textarea
                  v-model="form.editorialNotes"
                  @input="dirty = true" /></label
              ><label
                >Ограничения, одна на строку<Textarea
                  v-model="form.restrictionsText"
                  @input="dirty = true" /></label
              ><Button
                type="submit"
                :loading="save.isPending.value"
                :label="createMode ? 'Создать' : 'Сохранить новую revision'"
              />
            </form>
            <template v-if="selectedId"
              ><hr />
              <h3>Private reference</h3>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0]
                " /><Button
                label="Загрузить reference"
                :disabled="!file"
                :loading="upload.isPending.value"
                @click="upload.mutate()" />
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
                  {{ asset.originalFilename }} · {{ asset.status }} · rights:
                  {{ asset.currentAuthorization.status }}
                </p>
                <p v-if="asset.currentAuthorization.status === 'NOT_REVIEWED'">
                  Not reviewed не является разрешением.
                </p>
                <div v-if="asset.currentAuthorization.status !== 'CLEARED'">
                  <label
                    >Основание<InputText v-model="authorization.basis" /></label
                  ><label
                    >Scope<InputText v-model="authorization.scope" /></label
                  ><label
                    >Expiry (optional)<InputText
                      v-model="authorization.expiresAt"
                      placeholder="2026-12-31T00:00:00.000Z" /></label
                  ><Checkbox
                    v-model="authorization.externalProviderTransferAllowed"
                    binary
                    input-id="transfer"
                  /><label for="transfer"
                    >Можно передавать внешнему provider</label
                  ><Checkbox
                    v-model="authorization.attested"
                    binary
                    input-id="attest"
                  /><label for="attest"
                    >Подтверждаю commercial AI-image use</label
                  ><Button
                    label="Разрешить rights"
                    @click="updateRights.mutate(asset.id)"
                  />
                </div>
                <Button
                  v-if="asset.currentAuthorization.status === 'CLEARED'"
                  label="Использовать по умолчанию"
                  @click="setDefault.mutate(asset.id)"
                /><Button
                  v-if="asset.currentAuthorization.status === 'CLEARED'"
                  severity="danger"
                  outlined
                  label="Отозвать rights"
                  @click="revoke(asset.id)"
                /></article></template
          ></template>
        </section>
      </div>
      <p v-if="error" class="error" role="alert">
        {{ error }}
        <Button
          v-if="detail.isError.value"
          label="Загрузить серверную revision"
          severity="secondary"
          @click="detail.refetch()"
        />
      </p>
      <p v-if="success" role="status">{{ success }}</p></template
    >
  </main>
</template>
<style scoped>
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
