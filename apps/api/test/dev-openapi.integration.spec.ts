import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

let child: ChildProcess | undefined;

afterEach(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) =>
    child?.once("exit", () => resolveExit()),
  );
  child = undefined;
});

describe("development OpenAPI bootstrap", () => {
  it("starts through the real dev compiler and publishes the multipart schema", async () => {
    const port = await availablePort();
    const apiDirectory = resolve(import.meta.dirname, "..");
    child = spawn(process.execPath, ["scripts/dev.mjs"], {
      cwd: apiDirectory,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const document = await waitForOpenApi(port, () => {
      if (child?.exitCode !== null)
        throw new Error(`Development API exited early.\n${output}`);
    });
    const upload = document.components.schemas.CreateProjectUploadDto;
    if (!upload) throw new Error("CreateProjectUploadDto schema is missing.");
    expect(upload.required).toEqual(["name", "rightsConfirmed", "file"]);
    expect(upload.properties).toMatchObject({
      name: { type: "string", minLength: 1, maxLength: 200 },
      rightsConfirmed: { type: "string", enum: ["true"] },
      file: { type: "string", format: "binary" },
    });
    expect(document.components.schemas).toHaveProperty("ProjectResponseDto");
    expect(document.components.schemas).toHaveProperty("ErrorResponseDto");
  }, 20_000);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_TEST_PORT");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

interface OpenApiDocument {
  components: {
    schemas: Record<
      string,
      {
        required?: string[];
        properties?: Record<string, unknown>;
      }
    >;
  };
}

async function waitForOpenApi(
  port: number,
  assertRunning: () => void,
): Promise<OpenApiDocument> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assertRunning();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/docs-json`);
      if (response.ok) return (await response.json()) as OpenApiDocument;
    } catch {
      // The compiler and API are still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Development OpenAPI endpoint did not become ready.");
}
