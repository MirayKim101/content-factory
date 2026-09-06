<script setup lang="ts">
const route = useRoute();
const isOpen = ref(false);
const currentPath = computed(() => route.path);
function close(): void {
  isOpen.value = false;
}
</script>

<template>
  <button class="section-toggle" type="button" @click="isOpen = !isOpen">
    Разделы
  </button>
  <aside
    class="sidebar"
    :class="{ open: isOpen }"
    aria-label="Разделы приложения"
  >
    <NuxtLink
      to="/horizontal"
      :aria-current="currentPath === '/horizontal' ? 'page' : undefined"
      @click="close"
      >Горизонтальные видео</NuxtLink
    >
    <NuxtLink
      to="/library"
      :aria-current="currentPath === '/library' ? 'page' : undefined"
      @click="close"
      >Медиатека</NuxtLink
    >
    <NuxtLink
      to="/montage-assets"
      :aria-current="currentPath === '/montage-assets' ? 'page' : undefined"
      @click="close"
      >Монтажные материалы</NuxtLink
    >
    <span class="disabled" aria-disabled="true"
      >Вертикальные видео <small>Появится на Этапе 3</small></span
    >
  </aside>
</template>

<style scoped>
.sidebar {
  display: grid;
  align-content: start;
  gap: 0.45rem;
  box-sizing: border-box;
  width: 15rem;
  min-height: 100vh;
  padding: 1.5rem 1rem;
  background: #182b21;
}
a,
.disabled {
  padding: 0.8rem;
  border-radius: 0.6rem;
  color: #f5f8f4;
  font-weight: 650;
  text-decoration: none;
}
a[aria-current="page"] {
  background: #31533d;
}
.disabled {
  opacity: 0.7;
}
small {
  display: block;
  margin-top: 0.25rem;
  font-weight: 400;
}
.section-toggle {
  display: none;
}
@media (max-width: 1023px) {
  .section-toggle {
    display: block;
    margin: 0.75rem;
    min-height: 44px;
    padding: 0.5rem 0.8rem;
  }
  .sidebar {
    display: none;
    position: absolute;
    z-index: 10;
    width: min(18rem, calc(100vw - 2rem));
    min-height: 0;
    border-radius: 0.75rem;
    box-shadow: 0 12px 30px #0005;
  }
  .sidebar.open {
    display: grid;
  }
}
</style>
