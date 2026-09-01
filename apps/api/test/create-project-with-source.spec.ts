import { access, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateProjectWithSource } from "../src/projects/application/create-project-with-source.js";
import type { ObjectStorage } from "../src/projects/application/object-storage.port.js";
import type {
  CreatePendingUploadRecord,
  ProjectRepository,
  StorageReceipt,
} from "../src/projects/application/project-repository.port.js";
import type { ProjectView } from "../src/projects/domain/project.js";
import { tinyMp4 } from "./fixtures/mp4-fixture.js";

let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logError = vi
    .spyOn(Logger.prototype, "error")
    .mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

function repository(
  overrides: Partial<ProjectRepository> = {},
): ProjectRepository {
  return {
    createPendingUpload: vi.fn(async () => undefined),
    finalizeReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    requestCleanup: vi.fn(async () => undefined),
    findByIdempotencyKey: vi.fn(async () => null),
    getById: vi.fn(async () => projectView()),
    findStalePending: vi.fn(async () => []),
    findPendingCleanup: vi.fn(async () => []),
    markCleanupCompleted: vi.fn(async () => undefined),
    recordCleanupFailure: vi.fn(async () => undefined),
    ...overrides,
  };
}

function storage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    ensurePrivateBucket: vi.fn(async () => undefined),
    putFile: vi.fn(async () => ({ etag: "etag" })),
    headObject: vi.fn(async () => null),
    deleteObject: vi.fn(async () => undefined),
    ...overrides,
  };
}

function projectView(): ProjectView {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "test",
    status: "SOURCE_READY",
    rightsConfirmedAt: now,
    rightsDeclarationVersion: "upload-rights-v1",
    createdAt: now,
    updatedAt: now,
    source: {
      id: "00000000-0000-4000-8000-000000000002",
      status: "READY",
      sourceVersion: 1,
      originalFilename: "source.mp4",
      contentType: "video/mp4",
      sizeBytes: 44n,
      sha256: "a".repeat(64),
    },
    artifact: {
      id: "00000000-0000-4000-8000-000000000003",
      role: "SOURCE",
      status: "READY",
      sizeBytes: 44n,
      sha256: "a".repeat(64),
      contentType: "video/mp4",
      lineageSourceId: "00000000-0000-4000-8000-000000000002",
      lineageSourceVersion: 1,
      recipeVersion: "source-ingest-v1",
    },
  };
}

async function temporaryMp4(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "content-factory-create-"));
  const path = join(directory, "upload");
  await writeFile(path, tinyMp4(), { mode: 0o644 });
  return path;
}

describe("CreateProjectWithSource", () => {
  it("persists pending intent before upload, forces 0600, finalizes, and cleans temp", async () => {
    const events: string[] = [];
    const projects = repository({
      createPendingUpload: vi.fn(async (_record: CreatePendingUploadRecord) => {
        events.push("pending");
      }),
      finalizeReady: vi.fn(async (_id: string, _receipt: StorageReceipt) => {
        events.push("ready");
      }),
    });
    const objects = storage({
      putFile: vi.fn(async ({ filePath }) => {
        events.push("upload");
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        return { etag: "etag" };
      }),
    });
    const path = await temporaryMp4();

    const result = await new CreateProjectWithSource(projects, objects).execute(
      {
        name: " test ",
        originalFilename: "../unsafe/source.mp4",
        filePath: path,
        idempotencyKey: "test-key-0001",
      },
    );

    expect(result.status).toBe("SOURCE_READY");
    expect(events).toEqual(["pending", "upload", "ready"]);
    await expect(access(path)).rejects.toThrow();
    expect(projects.createPendingUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test", originalFilename: "source.mp4" }),
    );
  });

  it("marks stable failure and cleans temp when storage fails", async () => {
    const projects = repository();
    const objects = storage({
      putFile: vi.fn(async () => Promise.reject(new Error("vendor detail"))),
    });
    const path = await temporaryMp4();

    await expect(
      new CreateProjectWithSource(projects, objects).execute({
        name: "test",
        originalFilename: "source.mp4",
        filePath: path,
        idempotencyKey: "test-key-0002",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED" });

    expect(projects.markFailed).toHaveBeenCalledWith(
      expect.any(String),
      "STORAGE_UPLOAD_FAILED",
      "Source storage failed.",
      true,
    );
    expect(objects.deleteObject).toHaveBeenCalledTimes(1);
    const serializedLogs = JSON.stringify(logError.mock.calls);
    expect(serializedLogs).toContain("STORAGE_UPLOAD_FAILED");
    expect(serializedLogs).not.toContain("vendor detail");
    expect(serializedLogs).not.toContain(path);
    expect(serializedLogs).not.toContain("sources/");
    await expect(access(path)).rejects.toThrow();
  });

  it("deletes the uploaded object and marks failure if finalization fails", async () => {
    const projects = repository({
      finalizeReady: vi.fn(async () => Promise.reject(new Error("db"))),
    });
    const objects = storage();
    const path = await temporaryMp4();

    await expect(
      new CreateProjectWithSource(projects, objects).execute({
        name: "test",
        originalFilename: "source.mp4",
        filePath: path,
        idempotencyKey: "test-key-0003",
      }),
    ).rejects.toMatchObject({ code: "DATABASE_FINALIZE_FAILED" });

    expect(objects.deleteObject).toHaveBeenCalledTimes(1);
    expect(projects.markFailed).toHaveBeenCalledWith(
      expect.any(String),
      "DATABASE_FINALIZE_FAILED",
      "Source finalization failed.",
      true,
    );
    expect(projects.markCleanupCompleted).toHaveBeenCalledOnce();
  });

  it("returns the existing project for the same idempotent payload without uploading", async () => {
    const path = await temporaryMp4();
    const existing = projectView();
    const fingerprintRecord = { project: existing, requestFingerprint: "" };
    const projects = repository({
      findByIdempotencyKey: vi.fn(async () => fingerprintRecord),
    });
    const objects = storage();
    const service = new CreateProjectWithSource(projects, objects);

    const firstAttempt = service.execute({
      name: "test",
      originalFilename: "source.mp4",
      filePath: path,
      idempotencyKey: "same-key-0001",
    });
    await expect(firstAttempt).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(objects.putFile).not.toHaveBeenCalled();
  });
});
