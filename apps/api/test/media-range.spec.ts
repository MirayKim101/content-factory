import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MediaStreamService,
  parseByteRange,
} from "../src/cuts/media-stream.js";
import type { ObjectStorage } from "../src/projects/application/object-storage.port.js";

describe("safe byte ranges", () => {
  it.each([
    [undefined, { outcome: "FULL" }],
    ["bytes=0-9", { outcome: "PARTIAL", start: 0, end: 9 }],
    ["bytes=10-", { outcome: "PARTIAL", start: 10, end: 99 }],
    ["bytes=-10", { outcome: "PARTIAL", start: 90, end: 99 }],
    ["bytes=95-999", { outcome: "PARTIAL", start: 95, end: 99 }],
    ["bytes=100-", { outcome: "INVALID" }],
    ["bytes=10-9", { outcome: "INVALID" }],
    ["bytes=0-1,3-4", { outcome: "INVALID" }],
    ["items=0-1", { outcome: "INVALID" }],
  ])("parses %s", (header, expected) => {
    expect(parseByteRange(header, 100)).toEqual(expected);
  });

  it("aborts and destroys a blocked storage stream on client disconnect", async () => {
    const stream = new PassThrough();
    let storageSignal: AbortSignal | undefined;
    const storage: ObjectStorage = {
      ensurePrivateBucket: vi.fn(),
      putFile: vi.fn(),
      headObject: vi.fn(),
      deleteObject: vi.fn(),
      getObjectStream: vi.fn(async (input) => {
        storageSignal = input.signal;
        return stream;
      }),
    };
    const requestEvents = new EventEmitter();
    const request = Object.assign(requestEvents, {
      headers: {},
    }) as IncomingMessage;
    const response = new PassThrough() as unknown as ServerResponse;
    response.setHeader = vi.fn();
    const send = new MediaStreamService(storage).send({
      request,
      response,
      objectKey: "projects/project/cuts/job/output.mp4",
      sizeBytes: 100n,
      contentType: "video/mp4",
      disposition: "attachment",
      filename: "cut.mp4",
      head: false,
    });
    await vi.waitFor(() => expect(storageSignal).toBeDefined());
    requestEvents.emit("aborted");
    await send;
    expect(storageSignal?.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(stream.readableLength).toBe(0);
  });
});
