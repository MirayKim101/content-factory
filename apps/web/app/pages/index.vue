<script setup lang="ts">
import SourceUploadWidget from "~/widgets/source-upload/ui/source-upload-widget.vue";
</script>

<template>
  <main class="page-shell">
    <p class="eyebrow">Content Factory · Этап 1</p>
    <h1>Загрузить исходное видео</h1>
    <p class="intro">
      Добавь MP4, на который у тебя есть права. После загрузки мы покажем статус
      исходника и перейдём к выбору таймкодов.
    </p>
    <SourceUploadWidget />
  </main>
</template>

<style scoped>
.page-shell {
  box-sizing: border-box;
  max-width: 52rem;
  min-height: 100vh;
  margin: 0 auto;
  padding: clamp(3rem, 10vh, 7rem) 1.5rem;
}
.eyebrow {
  margin: 0;
  color: #65736b;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
h1 {
  margin: 0.4rem 0 1rem;
  font-size: clamp(2.25rem, 7vw, 4.5rem);
  letter-spacing: -0.05em;
  line-height: 0.98;
}
.intro {
  max-width: 40rem;
  margin: 0;
  color: #526159;
  font-size: 1.1rem;
  line-height: 1.6;
}
</style>
