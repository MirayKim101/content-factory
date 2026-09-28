<script setup lang="ts">
import Select from "primevue/select";
import { computed } from "vue";

import type { ProjectOption } from "~/shared/lib/project-option";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    options: ProjectOption[];
    inputId?: string;
    placeholder?: string;
    loading?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
  }>(),
  {
    modelValue: undefined,
    inputId: undefined,
    placeholder: "Выберите проект",
    loading: false,
    disabled: false,
    ariaLabel: "Проект",
  },
);
const emit = defineEmits<{
  "update:modelValue": [value: string | undefined];
}>();

const selected = computed(() =>
  props.options.find((option) => option.id === props.modelValue),
);
</script>

<template>
  <Select
    :input-id="inputId"
    :model-value="modelValue"
    :options="options"
    option-label="name"
    option-value="id"
    :placeholder="placeholder"
    :loading="loading"
    :disabled="disabled"
    :aria-label="ariaLabel"
    class="project-select"
    overlay-class="project-select-panel"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #value="{ placeholder: emptyLabel }">
      <span v-if="selected" class="project-select-value" :title="selected.name">
        {{ selected.name }}
      </span>
      <span v-else class="project-select-placeholder">{{ emptyLabel }}</span>
    </template>
    <template #option="{ option }">
      <span class="project-select-option">
        <strong :title="option.name">{{ option.name }}</strong>
        <small :title="option.detail">{{ option.detail }}</small>
      </span>
    </template>
    <template #empty>Проекты не найдены</template>
  </Select>
</template>

<style scoped>
.project-select {
  width: 100%;
  min-width: 0;
}
.project-select-value,
.project-select-placeholder {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-select-placeholder {
  color: var(--cf-text-muted);
}
.project-select-option {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}
.project-select-option strong,
.project-select-option small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-select-option strong {
  font-size: 0.9rem;
  font-weight: 700;
}
.project-select-option small {
  color: var(--cf-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
}
</style>
