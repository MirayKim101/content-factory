<script setup lang="ts">
/**
 * The cited research contract is available, but this editor is not yet linked
 * to a transcript intent. Keep the established manual path usable instead of
 * presenting an unscoped suggestion as an available result.
 */
</script>

<template>
  <section
    class="manual-fallback"
    aria-labelledby="research-text-manual-fallback-title"
  >
    <h3 id="research-text-manual-fallback-title">
      Исследование и варианты текста
    </h3>
    <p role="status">
      Для этого черновика research intent ещё не подключён. Заполните
      заголовок, описание и теги вручную, затем сохраните черновик.
    </p>
    <p class="hint">
      Для фактических утверждений проверьте источники перед сохранением.
      Подключённый режим подсказок покажет citations и свежесть исследования
      до применения варианта.
    </p>
  </section>
</template>

<style scoped>
.manual-fallback {
  display: grid;
  gap: 0.5rem;
  padding: 0.875rem;
  border: 1px solid #c4cec7;
  border-radius: 0.5rem;
  background: #f4f7f4;
}
h3,
p {
  margin: 0;
}
h3 {
  font-size: 1rem;
}
.hint {
  color: #4b5d51;
  font-size: 0.875rem;
}
</style>
