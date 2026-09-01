import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertArtifactMatches,
  exportOpenApiDocument,
} from "../scripts/openapi-contract.js";

const environment = {
  POSTGRES_DB: "openapi_contract",
  POSTGRES_USER: "openapi_contract",
  POSTGRES_PASSWORD: "openapi_contract",
  S3_ACCESS_KEY: "openapi_contract",
  S3_SECRET_KEY: "openapi_contract",
} as const;

const previousEnvironment = new Map<string, string | undefined>();
let temporaryDirectory: string;

beforeAll(async () => {
  for (const [name, value] of Object.entries(environment)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "content-factory-openapi-test-"),
  );
});

afterAll(async () => {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("authoritative OpenAPI export", () => {
  it("exports a deterministic schema and detects stale artifacts", async () => {
    const firstPath = join(temporaryDirectory, "first.json");
    const secondPath = join(temporaryDirectory, "second.json");
    await exportOpenApiDocument(firstPath);
    await exportOpenApiDocument(secondPath);

    const [first, second] = await Promise.all([
      readFile(firstPath, "utf8"),
      readFile(secondPath, "utf8"),
    ]);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      openapi: "3.0.0",
      paths: {
        "/api/v1/projects": { post: { requestBody: { required: true } } },
      },
      components: {
        schemas: {
          CreateProjectUploadDto: {
            required: ["name", "rightsConfirmed", "file"],
          },
        },
      },
    });
    expect(() =>
      assertArtifactMatches(first, second, "OpenAPI JSON"),
    ).not.toThrow();
    expect(() =>
      assertArtifactMatches(first, `${second} `, "OpenAPI JSON"),
    ).toThrow(/OpenAPI JSON drift detected/);
  });

  it("fails the frontend contract check for stale JSON and generated types", async () => {
    const staleSchema = join(temporaryDirectory, "stale-openapi.json");
    const staleTypes = join(temporaryDirectory, "stale-openapi.ts");
    await Promise.all([
      writeFile(staleSchema, "{}\n", "utf8"),
      writeFile(staleTypes, "export {};\n", "utf8"),
    ]);

    const contractScript = resolve(
      import.meta.dirname,
      "../../web/openapi/contract.mjs",
    );
    const result = await runNode([
      contractScript,
      "check",
      staleSchema,
      staleTypes,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "openapi/openapi.json differs from the live Nest contract",
    );
    expect(result.output).toContain(
      "app/shared/api/generated/openapi.ts differs from generated types",
    );
  });
});

async function runNode(arguments_: string[]): Promise<{
  exitCode: number;
  output: string;
}> {
  const child = spawn(process.execPath, arguments_, {
    cwd: resolve(import.meta.dirname, "../../.."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  return { exitCode, output };
}
