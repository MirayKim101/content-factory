<script setup lang="ts">
import AppNavigation from "~/shared/ui/app-navigation.vue";
</script>

<template>
  <div class="app-frame">
    <AppNavigation />
    <div class="app-stage">
      <NuxtPage />
    </div>
  </div>
</template>

<style>
.app-frame {
  display: grid;
  grid-template-columns: 17rem minmax(0, 1fr);
  min-height: 100vh;
}
.app-stage {
  min-width: 0;
  min-height: 100vh;
}
@media (max-width: 1023px) {
  .app-frame {
    display: block;
  }
  .app-stage {
    padding-top: 4rem;
  }
}
</style>
