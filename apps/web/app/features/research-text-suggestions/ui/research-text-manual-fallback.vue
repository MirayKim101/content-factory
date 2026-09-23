<script setup lang="ts">
/**
 * Stage 2B-4 has no frozen REST/OpenAPI contract yet. Keep the established
 * manual editor usable and make that boundary visible instead of sending an
 * invented request or presenting generated copy as an available result.
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
      Автоматические подсказки пока не подключены. Заполните заголовок,
      описание и теги вручную, затем сохраните черновик.
    </p>
    <p class="hint">
      Для фактических утверждений проверьте источники перед сохранением.
      Будущий режим подсказок покажет citations и свежесть исследования до
      применения варианта.
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
