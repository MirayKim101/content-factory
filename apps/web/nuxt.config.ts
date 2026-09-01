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
    },
  },
  runtimeConfig: {
    public: {
      apiBasePath: "/api/v1",
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
