import "reflect-metadata";
import { Readable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FrameEvidenceController } from "../src/ai-content/presentation/frame-evidence.controller.js";
import { FRAME_EVIDENCE_REPOSITORY } from "../src/ai-content/application/frame-evidence-repository.port.js";
import { CREATOR_CONTEXT_STORAGE } from "../src/ai-content/application/creator-context-storage.port.js";
import { JOB_DISPATCH } from "../src/media-pipeline/application/job-dispatch.port.js";
import { SourceAuthorizationRequiredError } from "../src/projects/domain/source-authorization.js";
import { AiContentIdempotencyConflictError } from "../src/ai-content/application/creator-context-repository.port.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";

const id = "11111111-1111-4111-8111-111111111111";
const frameId = "22222222-2222-4222-8222-222222222222";
const contentPath = `/api/v1/frame-evidence/${id}/frames/${frameId}/content`;
const collectionPath = `/api/v1/pipeline-jobs/${id}/frame-evidence`;
const sha256 = "a".repeat(64);
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const repository = {
  create: vi.fn(),
  detail: vi.fn(),
  list: vi.fn(),
  content: vi.fn(),
};
const storage = { headObject: vi.fn(), readObject: vi.fn() };
const dispatch = { dispatch: vi.fn() };

describe("frame evidence HTTP contract and private byte boundary", () => {
  let app: INestApplication;
  const oldFlags = {
    AI_CONTEXT_ENABLED: process.env.AI_CONTEXT_ENABLED,
    EDITORIAL_FRAMES_ENABLED: process.env.EDITORIAL_FRAMES_ENABLED,
  };
  beforeAll(async () => {
    app = await NestFactory.create(
      {
        module: class FrameTestModule {},
        controllers: [FrameEvidenceController],
        providers: [
          { provide: FRAME_EVIDENCE_REPOSITORY, useValue: repository },
          { provide: CREATOR_CONTEXT_STORAGE, useValue: storage },
          { provide: JOB_DISPATCH, useValue: dispatch },
        ],
      },
      { logger: false },
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(oldFlags)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.AI_CONTEXT_ENABLED = "1";
    process.env.EDITORIAL_FRAMES_ENABLED = "1";
    repository.create.mockResolvedValue(id);
    repository.detail.mockResolvedValue({
      id,
      pipelineJobId: frameId,
      job: { state: "QUEUED", attempt: 0 },
    });
    repository.list.mockResolvedValue({ items: [], nextCursor: null });
    repository.content.mockResolvedValue({
      objectKey: "exact-private-key",
      measurement: { sizeBytes: 4, sha256, ordinal: 0 },
    });
    storage.headObject.mockResolvedValue({ sizeBytes: 4, sha256 });
    storage.readObject.mockImplementation(
      async (_key: string, range?: string) => ({
        body: Readable.from(range ? bytes.subarray(1, 3) : bytes),
        contentLength: range ? 2 : 4,
        contentType: "image/jpeg",
        ...(range ? { contentRange: "bytes 1-2/4" } : {}),
      }),
    );
    dispatch.dispatch.mockResolvedValue(undefined);
  });

  it("exports required typed JSON body, string path IDs, binary/header/error schemas", () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const create =
      document.paths["/api/v1/pipeline-jobs/{cutJobId}/frame-evidence"]!.post!;
    expect(create.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateFrameEvidenceDto" },
        },
      },
    });
    expect(create.parameters).toContainEqual(
      expect.objectContaining({
        name: "cutJobId",
        schema: { type: "string", format: "uuid" },
      }),
    );
    expect(document.components?.schemas?.CreateFrameEvidenceDto).toMatchObject({
      required: ["sourceContextRevisionId", "cutPromptRevisionId"],
    });
    expect(
      document.components?.schemas?.FrameEvidenceErrorDetailDto,
    ).toMatchObject({ properties: { code: { type: "string" } } });
    expect(
      document.components?.schemas?.FrameEvidenceErrorDetailDto,
    ).not.toMatchObject({ properties: { code: { enum: expect.any(Array) } } });
    const route =
      document.paths[
        "/api/v1/frame-evidence/{intentId}/frames/{frameId}/content"
      ]!;
    expect(route.get!.responses["200"]).toMatchObject({
      content: {
        "image/jpeg": { schema: { type: "string", format: "binary" } },
      },
    });
    for (const method of [route.get!, route.head!]) {
      expect(method.responses["206"]).toMatchObject({
        headers: {
          "Content-Range": expect.any(Object),
          "Accept-Ranges": expect.any(Object),
          "Content-Length": expect.any(Object),
        },
      });
      for (const status of ["400", "404", "409", "416", "503"])
        expect(method.responses[status]).toBeDefined();
    }
  });

  it("requires exact body and both flags; durable dispatch failure preserves202", async () => {
    await request(app.getHttpServer())
      .post(collectionPath)
      .set("Idempotency-Key", "frames-test-1")
      .send({})
      .expect(400);
    dispatch.dispatch.mockRejectedValueOnce(new Error("redis unavailable"));
    await request(app.getHttpServer())
      .post(collectionPath)
      .set("Idempotency-Key", "frames-test-1")
      .send({ sourceContextRevisionId: id, cutPromptRevisionId: frameId })
      .expect(202);
    expect(repository.create).toHaveBeenCalledWith({
      cutPipelineJobId: id,
      sourceContextRevisionId: id,
      cutPromptRevisionId: frameId,
      idempotencyKey: "frames-test-1",
    });
    delete process.env.EDITORIAL_FRAMES_ENABLED;
    await request(app.getHttpServer())
      .post(collectionPath)
      .set("Idempotency-Key", "frames-test-2")
      .send({ sourceContextRevisionId: id, cutPromptRevisionId: frameId })
      .expect(503);
    await request(app.getHttpServer())
      .get(`/api/v1/frame-evidence/${id}`)
      .expect(200);
  });

  it("maps module-wide idempotency conflict to generic409", async () => {
    repository.create.mockRejectedValue(
      new AiContentIdempotencyConflictError(),
    );
    const result = await request(app.getHttpServer())
      .post(collectionPath)
      .set("Idempotency-Key", "frames-test-1")
      .send({ sourceContextRevisionId: id, cutPromptRevisionId: frameId })
      .expect(409);
    expect(result.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it.each(["get", "head"] as const)(
    "%s supports private200, single206, controlled416",
    async (method) => {
      const whole = await request(app.getHttpServer())
        [method](contentPath)
        .expect(200);
      expect(whole.headers["content-type"]).toContain("image/jpeg");
      expect(whole.headers["content-length"]).toBe("4");
      expect(whole.headers["cache-control"]).toBe("private, no-store");
      expect(whole.headers.etag).toBe(`"${sha256}"`);
      const partial = await request(app.getHttpServer())
        [method](contentPath)
        .set("Range", "bytes=1-2")
        .expect(206);
      expect(partial.headers["content-range"]).toBe("bytes 1-2/4");
      expect(partial.headers["content-length"]).toBe("2");
      const rejected = await request(app.getHttpServer())
        [method](contentPath)
        .set("Range", "bytes=100-")
        .expect(416);
      expect(rejected.headers["content-range"]).toBe("bytes */4");
      expect(rejected.headers["accept-ranges"]).toBe("bytes");
      if (method === "head") expect(storage.readObject).not.toHaveBeenCalled();
    },
  );

  it.each(["get", "head"] as const)(
    "%s rechecks rights before any storage operation",
    async (method) => {
      repository.content.mockRejectedValue(
        new SourceAuthorizationRequiredError(),
      );
      await request(app.getHttpServer())
        [method](contentPath)
        .set("Range", "bytes=0-1")
        .expect(409);
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(storage.readObject).not.toHaveBeenCalled();
    },
  );

  it.each(["get", "head"] as const)(
    "%s rejects missing or tampered objects",
    async (method) => {
      storage.headObject.mockResolvedValueOnce(null);
      await request(app.getHttpServer())[method](contentPath).expect(404);
      storage.headObject.mockResolvedValueOnce({ sizeBytes: 8, sha256 });
      await request(app.getHttpServer())[method](contentPath).expect(503);
      storage.headObject.mockResolvedValueOnce({
        sizeBytes: 4,
        sha256: "b".repeat(64),
      });
      await request(app.getHttpServer())[method](contentPath).expect(503);
      expect(storage.readObject).not.toHaveBeenCalled();
    },
  );

  it("bounds list pagination and rejects malformed UUID paths", async () => {
    await request(app.getHttpServer())
      .get(`${collectionPath}?limit=51`)
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/v1/frame-evidence/not-a-uuid")
      .expect(400);
    expect(repository.list).not.toHaveBeenCalled();
  });
});
