import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { Inject, Injectable } from "@nestjs/common";

import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../projects/application/object-storage.port.js";

export type ByteRange =
  | { outcome: "FULL" }
  | { outcome: "PARTIAL"; start: number; end: number }
  | { outcome: "INVALID" };

export function parseByteRange(
  value: string | undefined,
  size: number,
): ByteRange {
  if (!value) return { outcome: "FULL" };
  if (!/^bytes=\d*-\d*$/.test(value) || value.includes(","))
    return { outcome: "INVALID" };
  const [startText = "", endText = ""] = value.slice(6).split("-");
  if (!startText && !endText) return { outcome: "INVALID" };
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      return { outcome: "INVALID" };
    return {
      outcome: "PARTIAL",
      start: Math.max(0, size - suffix),
      end: size - 1,
    };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    return { outcome: "INVALID" };
  return { outcome: "PARTIAL", start, end: Math.min(requestedEnd, size - 1) };
}

@Injectable()
export class MediaStreamService {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async send(input: {
    request: IncomingMessage;
    response: ServerResponse;
    objectKey: string;
    sizeBytes: bigint;
    contentType: string;
    disposition: "inline" | "attachment";
    filename: string;
    head: boolean;
  }): Promise<void> {
    const size = Number(input.sizeBytes);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("MEDIA_SIZE_INVALID");
    const range = parseByteRange(input.request.headers.range, size);
    input.response.setHeader("Accept-Ranges", "bytes");
    input.response.setHeader(
      "Content-Type",
      input.contentType === "video/mp4"
        ? "video/mp4"
        : "application/octet-stream",
    );
    input.response.setHeader(
      "Content-Disposition",
      `${input.disposition}; filename="${safeFilename(input.filename)}"`,
    );
    if (range.outcome === "INVALID") {
      input.response.statusCode = 416;
      input.response.setHeader("Content-Range", `bytes */${size}`);
      input.response.setHeader("Content-Length", "0");
      input.response.end();
      return;
    }
    const start = range.outcome === "PARTIAL" ? range.start : undefined;
    const end = range.outcome === "PARTIAL" ? range.end : undefined;
    const length =
      range.outcome === "PARTIAL" ? range.end - range.start + 1 : size;
    input.response.statusCode = range.outcome === "PARTIAL" ? 206 : 200;
    input.response.setHeader("Content-Length", String(length));
    if (range.outcome === "PARTIAL")
      input.response.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${size}`,
      );
    if (input.head) {
      input.response.end();
      return;
    }
    const abort = new AbortController();
    const onAbort = (): void => abort.abort(new Error("CLIENT_DISCONNECTED"));
    input.request.once("aborted", onAbort);
    input.response.once("close", () => {
      if (!input.response.writableEnded) onAbort();
    });
    if (!this.storage.getObjectStream)
      throw new Error("STORAGE_STREAM_UNAVAILABLE");
    const stream = (await this.storage.getObjectStream({
      objectKey: input.objectKey,
      start,
      end,
      signal: abort.signal,
    })) as Readable;
    abort.signal.addEventListener(
      "abort",
      () => stream.destroy(abort.signal.reason),
      { once: true },
    );
    stream.pipe(input.response);
    try {
      await finished(stream);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      input.request.removeListener("aborted", onAbort);
    }
  }
}

function safeFilename(value: string): string {
  const base = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return base || "media.mp4";
}
