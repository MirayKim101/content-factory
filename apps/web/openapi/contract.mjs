import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = resolve(webDirectory, "../api");
const workspaceDirectory = resolve(webDirectory, "../..");
const openApiTypescriptCli = resolve(
  webDirectory,
  "node_modules/openapi-typescript/bin/cli.js",
);
const prettierCli = resolve(
  workspaceDirectory,
  "node_modules/prettier/bin/prettier.cjs",
);
const defaultSchema = resolve(webDirectory, "openapi/openapi.json");
const defaultTypes = resolve(
  webDirectory,
  "app/shared/api/generated/openapi.ts",
);

async function run(command, arguments_, cwd) {
  const child = spawn(command, arguments_, {
    cwd,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}.`);
  }
}

async function exportSchema(outputPath) {
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/openapi-contract.ts", "export", outputPath],
    apiDirectory,
  );
}

async function generateTypes(schemaPath, typesPath) {
  await run(
    process.execPath,
    [openApiTypescriptCli, schemaPath, "-o", typesPath],
    webDirectory,
  );
  await run(
    process.execPath,
    [prettierCli, "--write", typesPath],
    webDirectory,
  );
}

async function matches(expectedPath, actualPath) {
  const [expected, actual] = await Promise.all([
    readFile(expectedPath, "utf8"),
    readFile(actualPath, "utf8"),
  ]);
  return expected === actual;
}

async function generate(schemaPath, typesPath) {
  await exportSchema(schemaPath);
  await generateTypes(schemaPath, typesPath);
  console.log("OpenAPI JSON and TypeScript artifacts are up to date.");
}

async function check(expectedSchema, expectedTypes) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "content-factory-openapi-"),
  );
  try {
    const currentSchema = join(temporaryDirectory, "openapi.json");
    const currentTypes = join(temporaryDirectory, "openapi.ts");
    await exportSchema(currentSchema);
    await generateTypes(currentSchema, currentTypes);

    const drift = [];
    if (!(await matches(expectedSchema, currentSchema))) {
      drift.push("openapi/openapi.json differs from the live Nest contract");
    }
    if (!(await matches(expectedTypes, currentTypes))) {
      drift.push(
        "app/shared/api/generated/openapi.ts differs from generated types",
      );
    }
    if (drift.length > 0) {
      throw new Error(
        `OpenAPI drift detected:\n- ${drift.join("\n- ")}\nRun "pnpm --filter @content-factory/web generate:openapi" and review the diff.`,
      );
    }
    console.log(
      "OpenAPI JSON and TypeScript artifacts match the Nest contract.",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
const schemaPath = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : defaultSchema;
const typesPath = process.argv[4]
  ? resolve(process.cwd(), process.argv[4])
  : defaultTypes;
if (mode === "generate") await generate(schemaPath, typesPath);
else if (mode === "check") await check(schemaPath, typesPath);
else {
  throw new Error(
    "Usage: node openapi/contract.mjs <generate|check> [schema-path] [types-path]",
  );
}
