import "reflect-metadata";
import { Readable } from "node:stream";

import type { INestApplication } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplyImageSuggestion } from "../src/ai-content/application/apply-image-suggestion.js";
import { IMAGE_SUGGESTION_DISPATCH } from "../src/ai-content/application/image-suggestion-dispatch.port.js";
import { IMAGE_SUGGESTION_REPOSITORY, ImageSuggestionContextRejectedError } from "../src/ai-content/application/image-suggestion-repository.port.js";
import { ImageSuggestionController, parseImageRange } from "../src/ai-content/presentation/image-suggestion.controller.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";
import { OBJECT_STORAGE } from "../src/projects/application/object-storage.port.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const cutJobId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const sha256 = "a".repeat(64);
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const path = `/api/v1/projects/${projectId}/pipeline-jobs/${cutJobId}/image-suggestions/${intentId}/candidates/${candidateId}/content`;
const repository = { create: vi.fn(), detail: vi.fn(), list: vi.fn(), resolveForApply: vi.fn(), resolveContent: vi.fn() };
const storage = { ensurePrivateBucket: vi.fn(), putFile: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn(), readObject: vi.fn() };

describe("image suggestion private content boundary", () => {
  let app: INestApplication;
  const previousFlag = process.env.THUMBNAIL_SUGGESTIONS_ENABLED;

  beforeAll(async () => {
    app = await NestFactory.create({
      module: class ImageSuggestionTestModule {},
      controllers: [ImageSuggestionController],
      providers: [
        { provide: IMAGE_SUGGESTION_REPOSITORY, useValue: repository },
        { provide: IMAGE_SUGGESTION_DISPATCH, useValue: { dispatch: vi.fn() } },
        { provide: OBJECT_STORAGE, useValue: storage },
        { provide: ApplyImageSuggestion, useValue: { execute: vi.fn() } },
      ],
    }, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousFlag === undefined) delete process.env.THUMBNAIL_SUGGESTIONS_ENABLED;
    else process.env.THUMBNAIL_SUGGESTIONS_ENABLED = previousFlag;
  });

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.THUMBNAIL_SUGGESTIONS_ENABLED = "1";
    repository.detail.mockResolvedValue({ id: intentId, projectId, cutPipelineJobId: cutJobId });
    repository.resolveContent.mockResolvedValue({ projectId, objectKey: "private-image-key", contentType: "image/png", sizeBytes: 4n, sha256 });
    storage.headObject.mockResolvedValue({ sizeBytes: 4, sha256 });
    storage.readObject.mockImplementation(async (_key: string, range?: string) => ({
      body: Readable.from(range ? bytes.subarray(1, 3) : bytes),
      contentLength: range ? 2 : 4,
      contentType: "image/png",
      ...(range ? { contentRange: "bytes 1-2/4" } : {}),
    }));
  });

  it("serves private 200/206 and rejects malformed ranges with 416", async () => {
    const whole = await request(app.getHttpServer()).get(path).expect(200);
    expect(whole.headers["content-length"]).toBe("4");
    expect(whole.headers["cache-control"]).toBe("private, no-store");
    expect(whole.headers["x-content-type-options"]).toBe("nosniff");
    const partial = await request(app.getHttpServer()).get(path).set("Range", "bytes=1-2").expect(206);
    expect(partial.headers["content-range"]).toBe("bytes 1-2/4");
    await request(app.getHttpServer()).get(path).set("Range", "bytes=0-1,3-3").expect(416);
  });

  it("checks currentness and stored integrity before reading bytes", async () => {
    repository.resolveContent.mockRejectedValueOnce(new ImageSuggestionContextRejectedError("IMAGE_CONTEXT_STALE"));
    await request(app.getHttpServer()).get(path).expect(409);
    expect(storage.headObject).not.toHaveBeenCalled();
    storage.headObject.mockResolvedValueOnce({ sizeBytes: 9, sha256 });
    await request(app.getHttpServer()).get(path).expect(503);
    storage.headObject.mockResolvedValueOnce({ sizeBytes: 4, sha256: "b".repeat(64) });
    await request(app.getHttpServer()).get(path).expect(503);
    expect(storage.readObject).not.toHaveBeenCalled();
  });

  it("normalizes bounded ranges and rejects malformed forms", () => {
    expect(parseImageRange(undefined, 100)).toEqual({ start: 0, end: 99 });
    expect(parseImageRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseImageRange("bytes=95-999", 100)).toEqual({ start: 95, end: 99 });
    expect(parseImageRange("garbage", 100)).toBeNull();
    expect(parseImageRange(`bytes=${"1".repeat(101)}-`, 100)).toBeNull();
    expect(parseImageRange("bytes=100-", 100)).toBeNull();
  });
});
