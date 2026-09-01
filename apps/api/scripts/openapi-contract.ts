import "reflect-metadata";

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { OpenAPIObject } from "@nestjs/swagger";

import { createApp, createOpenApiDocument } from "../src/main.js";

const contractEnvironment = {
  POSTGRES_DB: "openapi_contract",
  POSTGRES_USER: "openapi_contract",
  POSTGRES_PASSWORD: "openapi_contract",
  S3_ACCESS_KEY: "openapi_contract",
  S3_SECRET_KEY: "openapi_contract",
} as const;
const prettierCli = resolve(
  import.meta.dirname,
  "../../../node_modules/prettier/bin/prettier.cjs",
);

function prepareContractEnvironment(): void {
  for (const [name, value] of Object.entries(contractEnvironment)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

export function normalizeOpenApiValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenApiValue);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, normalizeOpenApiValue(record[key])]),
  );
}

export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(normalizeOpenApiValue(document), null, 2)}\n`;
}

export function assertArtifactMatches(
  expected: string,
  actual: string,
  label: string,
): void {
  if (expected === actual) return;
  throw new Error(
    `${label} drift detected. Run "pnpm --filter @content-factory/web generate:openapi" and review the contract diff.`,
  );
}

export async function exportOpenApiDocument(outputPath: string): Promise<void> {
  prepareContractEnvironment();
  const app = await createApp();
  try {
    const document = createOpenApiDocument(app);
    const output = serializeOpenApiDocument(document);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, "utf8");
  } finally {
    await app.close();
  }
  await formatOpenApiJson(outputPath);
}

async function formatOpenApiJson(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [prettierCli, "--write", "--parser", "json", path],
    { stdio: "ignore" },
  );
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`OpenAPI formatter exited with code ${exitCode}.`);
  }
}

async function run(): Promise<void> {
  const [, , command, rawPath] = process.argv;
  if (!rawPath || (command !== "export" && command !== "check")) {
    throw new Error(
      "Usage: tsx scripts/openapi-contract.ts <export|check> <path>",
    );
  }

  const path = resolve(process.cwd(), rawPath);
  if (command === "export") {
    await exportOpenApiDocument(path);
    return;
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "content-factory-api-openapi-"),
  );
  try {
    const currentPath = join(temporaryDirectory, "openapi.json");
    await exportOpenApiDocument(currentPath);
    const actual = await readFile(currentPath, "utf8");
    const expected = await readFile(path, "utf8");
    assertArtifactMatches(expected, actual, "OpenAPI JSON");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await run();
}
