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
    const document = JSON.parse(first) as {
      paths: Record<
        string,
        {
          get?: {
            parameters?: unknown[];
            responses?: Record<string, unknown>;
          };
          put?: {
            parameters?: unknown[];
            requestBody?: unknown;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    expect(document).toMatchObject({
      openapi: "3.0.0",
      paths: {
        "/api/v1/projects": { post: { requestBody: { required: true } } },
      },
      components: {
        schemas: {
          CreateProjectUploadDto: {
            required: ["name", "file"],
          },
          SourceAuthorizationResponseDto: {},
          AttestSourceAuthorizationDto: {},
          ProcessingTemplateRevisionResponseDto: {},
          EditorialAssetResponseDto: {},
          EditorialPackageResponseDto: {},
          AssemblyRecipeResponseDto: {},
          SaveAssemblyRecipeDto: {},
          AssemblyRenderResponseDto: {},
          CreateAssemblyRenderDto: {},
        },
      },
    });
    expect(document.paths["/api/v1/processing-templates"]).toMatchObject({
      get: { responses: { "200": {} } },
      post: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "header",
            name: "Idempotency-Key",
            required: true,
          }),
        ]),
        responses: { "201": {}, "409": {} },
      },
    });
    expect(
      document.paths[
        "/api/v1/projects/{projectId}/editorial-assets/thumbnails"
      ],
    ).toMatchObject({
      get: { responses: { "200": {} } },
      post: {
        requestBody: {
          content: { "multipart/form-data": {} },
        },
        responses: {
          "201": {},
          "409": {},
          "413": {},
          "415": {},
          "422": {},
        },
      },
    });
    expect(
      document.paths["/api/v1/pipeline-jobs/{jobId}/editorial-package"],
    ).toMatchObject({
      get: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "path",
            name: "jobId",
            required: true,
          }),
        ]),
        responses: { "200": {}, "403": {}, "404": {}, "409": {} },
      },
      put: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "header",
            name: "Idempotency-Key",
            required: true,
          }),
          expect.objectContaining({ in: "path", name: "jobId" }),
        ]),
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/SaveEditorialPackageDto",
              },
            },
          },
        },
        responses: {
          "200": {},
          "403": {},
          "404": {},
          "409": {},
          "422": {},
        },
      },
    });
    expect(
      document.paths["/api/v1/projects/{projectId}/editorial-packages"]?.get,
    ).toMatchObject({
      responses: { "200": {}, "403": {}, "404": {}, "409": {} },
    });
    expect(
      document.paths["/api/v1/pipeline-jobs/{jobId}/assembly-recipe"],
    ).toMatchObject({
      get: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "path",
            name: "jobId",
            required: true,
          }),
        ]),
        responses: { "200": {}, "403": {}, "404": {}, "409": {} },
      },
      put: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "header",
            name: "Idempotency-Key",
            required: true,
          }),
          expect.objectContaining({ in: "path", name: "jobId" }),
        ]),
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/SaveAssemblyRecipeDto",
              },
            },
          },
        },
        responses: {
          "200": {},
          "400": {},
          "403": {},
          "404": {},
          "409": {},
          "422": {},
        },
      },
    });
    expect(
      document.paths[
        "/api/v1/pipeline-jobs/{jobId}/assembly-recipe/revisions/{revision}"
      ]?.get,
    ).toMatchObject({
      responses: { "200": {}, "403": {}, "404": {}, "409": {} },
    });
    expect(
      document.paths["/api/v1/projects/{projectId}/assembly-recipes"]?.get,
    ).toMatchObject({
      parameters: expect.arrayContaining([
        expect.objectContaining({
          in: "query",
          name: "cursor",
          required: false,
          schema: { type: "string", format: "uuid" },
        }),
        expect.objectContaining({
          in: "query",
          name: "limit",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        }),
      ]),
      responses: { "200": {}, "400": {}, "403": {}, "404": {}, "409": {} },
    });
    expect(document).toMatchObject({
      components: {
        schemas: {
          SaveAssemblyRecipeDto: {
            required: [
              "expectedRevision",
              "banners",
              "audioProfileVersion",
              "encodingProfileVersion",
            ],
            properties: {
              banners: { type: "array", maxItems: 8 },
              audioProfileVersion: { enum: ["youtube-stereo-v1"] },
              encodingProfileVersion: { enum: ["youtube-h264-v1"] },
            },
          },
          AssemblyRecipeResponseDto: {
            properties: {
              cutResultArtifact: {
                $ref: "#/components/schemas/AssemblyCutSnapshotResponseDto",
              },
              revision: {
                $ref: "#/components/schemas/AssemblyRecipeRevisionResponseDto",
              },
            },
          },
        },
      },
    });
    expect(
      document.paths["/api/v1/pipeline-jobs/{cutJobId}/assembly-renders"],
    ).toMatchObject({
      post: {
        parameters: expect.arrayContaining([
          expect.objectContaining({
            in: "header",
            name: "Idempotency-Key",
            required: true,
          }),
          expect.objectContaining({
            in: "path",
            name: "cutJobId",
            required: true,
          }),
        ]),
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAssemblyRenderDto" },
            },
          },
        },
        responses: {
          "202": {},
          "400": {},
          "403": {},
          "404": {},
          "409": {},
          "422": {},
          "503": {},
        },
      },
    });
    expect(
      document.paths["/api/v1/assembly-renders/{renderId}"]?.get,
    ).toMatchObject({
      responses: { "200": {} },
    });
    expect(
      document.paths["/api/v1/projects/{projectId}/assembly-renders"]?.get,
    ).toMatchObject({
      responses: { "200": {} },
    });
    expect(document).toMatchObject({
      components: {
        schemas: {
          SaveEditorialPackageDto: {
            required: ["expectedRevision", "processingTemplateRevisionId"],
            properties: {
              expectedRevision: {
                type: "integer",
                format: "int32",
                minimum: 0,
                maximum: 2_147_483_646,
              },
              tags: {
                type: "array",
                nullable: true,
                minItems: 0,
                maxItems: 30,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 100,
                  pattern: "\\S",
                },
              },
            },
          },
        },
      },
    });
    expect(
      document.paths["/api/v1/projects/{id}/source-authorization"]?.put,
    ).toMatchObject({
      parameters: [
        expect.objectContaining({ in: "path", name: "id", required: true }),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/AttestSourceAuthorizationDto",
            },
          },
        },
      },
      responses: {
        "200": {},
        "400": {},
        "409": {},
        "422": {},
      },
    });
    for (const path of [
      "/api/v1/projects/{projectId}/source",
      "/api/v1/pipeline-jobs/{id}/result",
      "/api/v1/assembly-renders/{renderId}/content",
    ]) {
      const operation = document.paths[path]?.get;
      expect(operation?.parameters).toContainEqual(
        expect.objectContaining({
          in: "header",
          name: "Range",
          required: false,
        }),
      );
      expect(operation?.responses).toMatchObject({
        "200": { content: { "video/mp4": {} } },
        "206": {
          content: { "video/mp4": {} },
          headers: {
            "Accept-Ranges": {},
            "Content-Range": {},
          },
        },
        "416": {
          content: { "application/json": {} },
          headers: {
            "Accept-Ranges": {},
            "Content-Range": {},
          },
        },
      });
    }
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
