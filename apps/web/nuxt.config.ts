import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2026-09-01",
  devtools: { enabled: true },
  ssr: false,
  css: ["~/assets/css/main.css"],
  modules: ["@primevue/nuxt-module"],
  primevue: {
    options: {
      unstyled: true,
      pt: {
        select: {
          root: { class: "p-select" },
          label: { class: "p-select-label" },
          dropdown: { class: "p-select-dropdown" },
          dropdownIcon: { class: "p-select-dropdown-icon" },
          overlay: { class: "p-select-overlay" },
          listContainer: { class: "p-select-list-container" },
          list: { class: "p-select-list" },
          option: { class: "p-select-option" },
          optionLabel: { class: "p-select-option-label" },
          emptyMessage: { class: "p-select-empty-message" },
        },
      },
    },
  },
  runtimeConfig: {
    public: {
      apiBasePath: "/api/v1",
      aiContextEnabled: process.env.AI_CONTEXT_ENABLED === "1",
      editorialFramesEnabled: process.env.EDITORIAL_FRAMES_ENABLED === "1",
    },
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        "/api/v1": {
          target: "http://127.0.0.1:3001",
          changeOrigin: true,
        },
      },
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
