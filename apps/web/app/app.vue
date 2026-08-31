<template>
  <main class="shell">
    <p class="eyebrow">Content Factory</p>
    <h1>Локальная нарезка видео</h1>
    <p>Каркас админки готов. Следующий шаг — загрузка исходного файла.</p>
  </main>
</template>

<style>
:root {
  color: #16211c;
  background: #f3f5ef;
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

.shell {
  box-sizing: border-box;
  min-height: 100vh;
  padding: 12vh 8vw;
}

.eyebrow {
  color: #65736b;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1 {
  max-width: 12ch;
  margin: 0.25rem 0 1rem;
  font-size: clamp(2.5rem, 8vw, 6rem);
  letter-spacing: -0.055em;
  line-height: 0.95;
}

.shell > p:last-child {
  max-width: 36rem;
  color: #526159;
  font-size: 1.1rem;
  line-height: 1.6;
}
</style>
