<script setup lang="ts">
import AppNavigation from "~/shared/ui/app-navigation.vue";
</script>

<template>
  <div class="app-frame">
    <AppNavigation />
    <NuxtPage />
  </div>
</template>

<style>
:root {
  color: #18221d;
  background: #f4f6f1;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

body {
  margin: 0;
}

.app-frame {
  display: flex;
  min-height: 100vh;
}
.app-frame > :last-child {
  min-width: 0;
  flex: 1;
}
@media (max-width: 1023px) {
  .app-frame {
    display: block;
  }
}
</style>
