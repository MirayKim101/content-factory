<script setup lang="ts">
import Button from "primevue/button";
import Message from "primevue/message";
import Select from "primevue/select";
import { computed, ref, watch } from "vue";

import MontageAssetCard from "~/entities/montage-asset/ui/montage-asset-card.vue";
import { useMontageAssets } from "~/entities/montage-asset/model/use-montage-assets";
import MontageAssetUpload from "~/features/upload-montage-asset/ui/montage-asset-upload.vue";
import { createMontageAssetsApi } from "~/shared/api/montage-assets";
import { createProjectsApi } from "~/shared/api/projects";

const route = useRoute();
const config = useRuntimeConfig();
const projectsApi = createProjectsApi({
  apiBasePath: config.public.apiBasePath,
});
const montageApi = createMontageAssetsApi({
  apiBasePath: config.public.apiBasePath,
});
const selectedProjectId = ref<string>();
const projects = ref<Array<{ id: string; label: string }>>([]);
const projectsLoading = ref(true);
const projectsError = ref<string>();
const uploadActive = ref(false);

const assets = useMontageAssets(selectedProjectId);
const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value),
);

async function loadProjects(): Promise<void> {
  projectsLoading.value = true;
  projectsError.value = undefined;
  try {
    const page = await projectsApi.listProjects!({ limit: 50 });
    projects.value = page.items.map((project) => ({
      id: project.id,
      label: `${project.name} · ${project.source.originalFilename}`,
    }));
    const fromUrl =
      typeof route.query.projectId === "string"
        ? route.query.projectId
        : undefined;
    selectedProjectId.value = projects.value.some(
      (project) => project.id === fromUrl,
    )
      ? fromUrl
      : projects.value[0]?.id;
  } catch (error) {
    projectsError.value =
      error instanceof Error
        ? error.message
        : "Не удалось загрузить список проектов.";
  } finally {
    projectsLoading.value = false;
  }
}
function changeProject(id: string | undefined): void {
  if (uploadActive.value) return;
  selectedProjectId.value = id;
  void navigateTo({
    path: "/montage-assets",
    query: id ? { projectId: id } : {},
  });
}
function refreshAssets(): void {
  void assets.refetch();
}
watch(
  () => route.query.projectId,
  (value) => {
    const projectId = typeof value === "string" ? value : undefined;
    if (projects.value.some((project) => project.id === projectId))
      selectedProjectId.value = projectId;
  },
);
void loadProjects();
</script>

<template>
  <main class="montage-workspace" aria-labelledby="montage-assets-title">
    <header class="montage-header">
      <div>
        <p class="eyebrow">Content Factory · Этап 2</p>
        <h1 id="montage-assets-title">Монтажные материалы</h1>
        <p>
          Загрузите интро, аутро, рекламу и баннеры для будущей сборки ролика.
        </p>
      </div>
      <Button
        label="Обновить список"
        severity="secondary"
        :loading="assets.isFetching.value"
        :disabled="!selectedProjectId"
        @click="refreshAssets"
      />
    </header>

    <section class="project-picker" aria-label="Выбор проекта">
      <label for="montage-project">Проект</label>
      <Select
        id="montage-project"
        :model-value="selectedProjectId"
        :options="projects"
        option-label="label"
        option-value="id"
        :loading="projectsLoading"
        :disabled="uploadActive"
        placeholder="Выберите проект"
        @update:model-value="changeProject"
      />
      <Message v-if="projectsError" severity="error" :closable="false">
        {{ projectsError }}
        <Button label="Повторить" severity="secondary" @click="loadProjects" />
      </Message>
    </section>

    <template v-if="selectedProjectId">
      <section class="upload-panel" aria-labelledby="montage-upload-title">
        <h2 id="montage-upload-title">Добавить материал</h2>
        <p v-if="selectedProject" class="selected-project">
          Для: {{ selectedProject.label }}
        </p>
        <MontageAssetUpload
          :project-id="selectedProjectId"
          @activity="uploadActive = $event"
          @uploaded="refreshAssets"
        />
      </section>
      <section class="assets-section" aria-labelledby="montage-list-title">
        <div class="assets-heading">
          <div>
            <h2 id="montage-list-title">Материалы проекта</h2>
            <p
              v-if="
                assets.data.value?.some(
                  (asset) =>
                    asset.status === 'UPLOADING' ||
                    asset.status === 'PROBE_PENDING',
                )
              "
              role="status"
            >
              Проверяем загруженные материалы — список обновляется
              автоматически.
            </p>
          </div>
        </div>
        <p v-if="assets.isLoading.value" aria-busy="true">
          Загружаем материалы…
        </p>
        <Message
          v-else-if="assets.isError.value"
          severity="error"
          :closable="false"
        >
          Не удалось загрузить материалы.
          <Button
            label="Повторить"
            severity="secondary"
            @click="refreshAssets"
          />
        </Message>
        <p v-else-if="!assets.data.value?.length" class="empty-assets">
          Пока материалов нет. Добавьте MP4 или баннер выше.
        </p>
        <div v-else class="asset-grid">
          <MontageAssetCard
            v-for="asset in assets.data.value"
            :key="asset.id"
            :asset="asset"
            :content-url="montageApi.contentUrl(selectedProjectId, asset.id)"
          />
        </div>
      </section>
    </template>
    <section
      v-else-if="!projectsLoading && !projectsError"
      class="empty-assets"
    >
      <p>В медиатеке пока нет проектов. Сначала загрузите исходное видео.</p>
      <NuxtLink class="action-link" to="/">Открыть загрузку видео</NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.montage-workspace {
  box-sizing: border-box;
  max-width: 90rem;
  margin: 0 auto;
  padding: 2rem;
}
.montage-header,
.assets-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
}
.montage-header h1,
.assets-section h2,
.upload-panel h2 {
  margin: 0.2rem 0 0.45rem;
}
.montage-header p,
.selected-project,
.assets-heading p {
  margin: 0;
  color: #4e5d53;
}
.project-picker {
  display: grid;
  max-width: 46rem;
  gap: 0.45rem;
  margin: 1.5rem 0;
}
.project-picker label {
  font-weight: 700;
}
.upload-panel,
.assets-section {
  border: 1px solid #d5ddd5;
  border-radius: 0.75rem;
  background: #fff;
  padding: 1.25rem;
}
.assets-section {
  margin-top: 1.25rem;
}
.selected-project {
  margin-bottom: 1rem;
}
.asset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
.empty-assets {
  margin: 1.25rem 0;
  padding: 1.25rem;
  border: 1px dashed #9ba9a0;
  border-radius: 0.75rem;
}
@media (max-width: 1100px) {
  .asset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
