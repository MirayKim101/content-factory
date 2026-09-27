<script setup lang="ts">
import SourceUploadWidget from "~/widgets/source-upload/ui/source-upload-widget.vue";
</script>

<template>
  <main class="page-shell">
    <nav class="breadcrumbs" aria-label="Хлебные крошки">
      <span>Производство</span><span aria-hidden="true">/</span><strong>Новый источник</strong>
    </nav>
    <div class="page-heading">
      <p class="eyebrow">Новый источник</p>
      <h1>Загрузка видео</h1>
      <p class="intro">
        Добавьте исходный MP4. После проверки он появится в медиатеке и станет
        доступен для нарезки.
      </p>
    </div>
    <SourceUploadWidget />
  </main>
</template>

<style scoped>
.page-shell {
  box-sizing: border-box;
  max-width: 72rem;
  min-height: 100vh;
  margin: 0 auto;
  padding: 2rem clamp(1.25rem, 3vw, 3.25rem) 5rem;
}
.page-heading {
  max-width: 48rem;
}
.breadcrumbs {
  display: flex;
  gap: 0.45rem;
  margin-bottom: 1.15rem;
  color: var(--cf-text-muted);
  font-size: 0.78rem;
}
.eyebrow {
  margin: 0;
  color: var(--cf-brand-strong);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
h1 {
  margin: 0.15rem 0 0.5rem;
  font-size: clamp(2rem, 3vw, 2.65rem);
  font-weight: 760;
  letter-spacing: -0.045em;
  line-height: 1.08;
}
.intro {
  max-width: 40rem;
  margin: 0;
  color: var(--cf-text-muted);
  font-size: 1rem;
  line-height: 1.55;
}
</style>
