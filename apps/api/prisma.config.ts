import { resolve } from "node:path";

import { defineConfig } from "prisma/config";

import { databaseUrl, loadEnvironment } from "./src/config/environment.js";

loadEnvironment();

export default defineConfig({
  schema: resolve(import.meta.dirname, "prisma/schema.prisma"),
  migrations: {
    path: resolve(import.meta.dirname, "prisma/migrations"),
  },
  datasource: {
    url: databaseUrl(),
  },
});
