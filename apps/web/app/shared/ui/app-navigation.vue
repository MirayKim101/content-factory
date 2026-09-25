<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

const route = useRoute();
const isOpen = ref(false);
const isMobile = ref(false);
const sidebar = ref<HTMLElement>();
const sectionToggle = ref<HTMLButtonElement>();
const currentPath = computed(() => route.path);
const navigation = [
  {
    label: "Производство",
    items: [
      { to: "/horizontal", label: "Горизонтальные видео", marker: "H" },
      { to: "/library", label: "Медиатека", marker: "M" },
      { to: "/montage-assets", label: "Монтажные материалы", marker: "A" },
    ],
  },
  {
    label: "Настройки",
    items: [
      { to: "/creator-context", label: "Контекст автора", marker: "C" },
    ],
  },
] as const;
function close(restoreFocus = false): void {
  isOpen.value = false;
  if (restoreFocus) void nextTick(() => sectionToggle.value?.focus());
}
function toggleMenu(): void {
  if (isOpen.value) {
    close(true);
    return;
  }
  isOpen.value = true;
  void nextTick(() => {
    sidebar.value?.querySelector<HTMLElement>("button, a[href]")?.focus();
  });
}

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape" && isOpen.value) close(true);
}
function containMobileFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !isMobile.value || !isOpen.value) return;
  const focusable = Array.from(
    sidebar.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
let mobileQuery: MediaQueryList | undefined;
function syncMobile(event: MediaQueryListEvent | MediaQueryList): void {
  isMobile.value = event.matches;
  if (!event.matches) isOpen.value = false;
}

watch(currentPath, () => close());
onMounted(() => {
  mobileQuery = window.matchMedia("(max-width: 1023px)");
  syncMobile(mobileQuery);
  mobileQuery.addEventListener("change", syncMobile);
  document.addEventListener("keydown", closeOnEscape);
  document.addEventListener("keydown", containMobileFocus);
});
onBeforeUnmount(() => {
  mobileQuery?.removeEventListener("change", syncMobile);
  document.removeEventListener("keydown", closeOnEscape);
  document.removeEventListener("keydown", containMobileFocus);
});
</script>

<template>
  <header class="mobile-header">
    <NuxtLink to="/horizontal" class="mobile-brand" @click="close(true)">
      <span class="brand-mark" aria-hidden="true">CF</span>
      <span>Content Factory</span>
    </NuxtLink>
    <button
      ref="sectionToggle"
      class="section-toggle"
      type="button"
      :aria-expanded="isOpen"
      aria-controls="primary-navigation"
      @click="toggleMenu"
    >
      <span aria-hidden="true">☰</span>
      <span>{{ isOpen ? "Закрыть" : "Разделы" }}</span>
    </button>
  </header>
  <aside
    id="primary-navigation"
    ref="sidebar"
    class="sidebar"
    :class="{ open: isOpen }"
    :inert="isMobile && !isOpen ? true : undefined"
    :aria-hidden="isMobile && !isOpen ? 'true' : undefined"
    aria-label="Разделы приложения"
  >
    <button class="drawer-close" type="button" @click="close(true)">
      <span aria-hidden="true">×</span>
      <span class="sr-only">Закрыть меню</span>
    </button>
    <NuxtLink to="/horizontal" class="brand" @click="close(true)">
      <span class="brand-mark" aria-hidden="true">CF</span>
      <span class="brand-copy">
        <strong>Content Factory</strong>
        <small>Production workspace</small>
      </span>
    </NuxtLink>

    <nav class="nav-groups" aria-label="Основная навигация">
      <section v-for="group in navigation" :key="group.label" class="nav-group">
        <p>{{ group.label }}</p>
        <NuxtLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          :aria-current="currentPath === item.to ? 'page' : undefined"
          @click="close(true)"
        >
          <span class="nav-marker" aria-hidden="true">{{ item.marker }}</span>
          <span>{{ item.label }}</span>
        </NuxtLink>
      </section>
    </nav>

    <div class="future-section" aria-disabled="true">
      <span class="nav-marker" aria-hidden="true">V</span>
      <span>
        <strong>Вертикальные видео</strong>
        <small>Этап 3 · позже</small>
      </span>
    </div>

    <footer class="sidebar-footer">
      <span class="system-dot" aria-hidden="true"></span>
      <span><strong>Локальный контур</strong><small>Данные не публикуются</small></span>
    </footer>
  </aside>
  <button
    v-if="isOpen"
    class="nav-backdrop"
    type="button"
    aria-label="Закрыть меню"
    @click="close(true)"
  />
</template>

<style scoped>
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 17rem;
  height: 100vh;
  min-height: 100vh;
  padding: 1.25rem 1rem 1rem;
  overflow-y: auto;
  border-right: 1px solid #203d35;
  background:
    radial-gradient(circle at 10% 0%, rgb(65 132 103 / 0.2), transparent 32%),
    #112820;
  color: #f5faf7;
}
.brand,
.mobile-brand {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  color: #fff;
  text-decoration: none;
}
.brand {
  margin: 0 0.3rem 1.6rem;
}
.brand-mark {
  display: grid;
  flex: 0 0 2.25rem;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 0.22);
  border-radius: 0.75rem;
  background: linear-gradient(145deg, #4aaf84, #1b7655);
  box-shadow: inset 0 1px rgb(255 255 255 / 0.2);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.brand-copy {
  display: grid;
  min-width: 0;
}
.brand-copy strong {
  font-size: 1rem;
  letter-spacing: -0.01em;
}
.brand-copy small,
.future-section small,
.sidebar-footer small {
  display: block;
  color: #a9bdb5;
  font-size: 0.72rem;
  font-weight: 400;
}
.nav-groups {
  display: grid;
  gap: 1.35rem;
}
.nav-group {
  display: grid;
  gap: 0.25rem;
}
.nav-group > p {
  margin: 0 0.55rem 0.35rem;
  color: #8da69d;
  font-size: 0.7rem;
  font-weight: 750;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.nav-group a,
.future-section {
  display: flex;
  gap: 0.7rem;
  align-items: center;
  min-height: 2.75rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid transparent;
  border-radius: 0.7rem;
  color: #dbe8e2;
  font-weight: 620;
  text-decoration: none;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.nav-group a:hover {
  background: rgb(255 255 255 / 0.06);
  color: #fff;
}
.nav-group a:focus-visible,
.brand:focus-visible,
.mobile-brand:focus-visible {
  outline: 3px solid #69c59d;
  outline-offset: 2px;
}
.nav-group a[aria-current="page"] {
  border-color: rgb(126 211 174 / 0.17);
  background: rgb(82 164 128 / 0.2);
  color: #fff;
}
.nav-marker {
  display: grid;
  flex: 0 0 1.75rem;
  width: 1.75rem;
  height: 1.75rem;
  place-items: center;
  border-radius: 0.52rem;
  background: rgb(255 255 255 / 0.08);
  color: #bcd9cd;
  font-size: 0.72rem;
  font-weight: 800;
}
.nav-group a[aria-current="page"] .nav-marker {
  background: #55aa82;
  color: #0f3024;
}
.future-section {
  margin-top: 1.35rem;
  opacity: 0.62;
}
.future-section > span:last-child {
  min-width: 0;
}
.sidebar-footer {
  display: flex;
  gap: 0.7rem;
  align-items: center;
  margin-top: auto;
  padding: 0.85rem 0.65rem 0.2rem;
  border-top: 1px solid rgb(255 255 255 / 0.09);
  color: #dbe8e2;
  font-size: 0.78rem;
}
.system-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: #5fd097;
  box-shadow: 0 0 0 0.22rem rgb(95 208 151 / 0.13);
}
.mobile-header,
.section-toggle,
.nav-backdrop,
.drawer-close {
  display: none;
}
@media (max-width: 1023px) {
  .mobile-header {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 1200;
    display: flex;
    height: 4rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.65rem 1rem;
    border-bottom: 1px solid var(--cf-border);
    background: rgb(255 255 255 / 0.96);
    backdrop-filter: blur(14px);
  }
  .mobile-brand {
    color: var(--cf-text);
    font-weight: 750;
  }
  .section-toggle {
    display: inline-flex;
    gap: 0.45rem;
    align-items: center;
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--cf-border-strong);
    border-radius: var(--cf-radius-sm);
    background: #fff;
    color: var(--cf-text);
    font-weight: 700;
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 1301;
    width: min(18rem, calc(100vw - 3rem));
    height: 100vh;
    min-height: 100vh;
    transform: translateX(-102%);
    box-shadow: var(--cf-shadow-lg);
    transition: transform 180ms ease;
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .drawer-close {
    position: absolute;
    top: 0.9rem;
    right: 0.85rem;
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border: 1px solid rgb(255 255 255 / 0.16);
    border-radius: var(--cf-radius-sm);
    background: rgb(255 255 255 / 0.06);
    color: #fff;
    font-size: 1.5rem;
  }
  .nav-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1300;
    display: block;
    border: 0;
    background: rgb(8 20 17 / 0.52);
  }
}
</style>
