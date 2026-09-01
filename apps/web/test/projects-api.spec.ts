import { describe, expect, it, vi } from "vitest";

import { createProjectsApi } from "~/shared/api/projects";

describe("projects API adapter", () => {
  it("sends the exact relative endpoint, idempotency header, and multipart fields", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          name: "x",
          status: "SOURCE_READY",
          rights: {
            confirmedAt: "2026-09-01T00:00:00.000Z",
            declarationVersion: "x",
          },
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          source: {
            id: "00000000-0000-4000-8000-000000000002",
            status: "READY",
            sourceVersion: 1,
            originalFilename: "x.mp4",
            contentType: "video/mp4",
            sizeBytes: "1",
            sha256: "a".repeat(64),
          },
          artifact: {
            id: "00000000-0000-4000-8000-000000000003",
            role: "SOURCE",
            status: "READY",
            sizeBytes: "1",
            sha256: "a".repeat(64),
            contentType: "video/mp4",
            lineageSourceId: "00000000-0000-4000-8000-000000000002",
            lineageSourceVersion: 1,
            recipeVersion: "x",
          },
        }),
        { status: 201 },
      ),
    );
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      fetchImplementation,
    });
    await api.createProject({
      name: "x",
      file: new File(["x"], "x.mp4", { type: "video/mp4" }),
      idempotencyKey: "attempt-0001",
    });
    const [url, init] = fetchImplementation.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/projects");
    expect(init.headers).toEqual({ "Idempotency-Key": "attempt-0001" });
    const body = init.body as FormData;
    expect(body.get("name")).toBe("x");
    expect(body.get("rightsConfirmed")).toBe("true");
    expect(body.get("file")).toBeInstanceOf(File);
  });
});
