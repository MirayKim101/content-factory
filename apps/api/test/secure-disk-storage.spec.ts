import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  UPLOAD_REQUEST_DIRECTORY,
  UPLOAD_RESPONSE_EVENTS,
  UPLOAD_STAGING_RESERVATION,
  SecureDiskStorage,
  type TrackedUploadRequest,
} from "../src/projects/presentation/secure-disk-storage.js";

describe("SecureDiskStorage", () => {
  it("destroys a live upload on transport abort and releases only after the pipeline settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-upload-storage-"));
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    }) as unknown as TrackedUploadRequest;
    const closeWriter = vi.fn();
    request[UPLOAD_REQUEST_DIRECTORY] = directory;
    request[UPLOAD_STAGING_RESERVATION] = {
      beginWriter: () => closeWriter,
    } as never;
    const input = new PassThrough();
    const file = { stream: input } as unknown as Express.Multer.File;
    const storage = new SecureDiskStorage();

    try {
      const callback = new Promise<unknown>((resolve) => {
        storage._handleFile(request, file, (error) => resolve(error));
      });
      input.write(Buffer.alloc(1_024));
      await new Promise<void>((resolve) => setImmediate(resolve));
      (request as unknown as { aborted: boolean }).aborted = true;
      (request as unknown as EventEmitter).emit("aborted");

      await expect(callback).resolves.toBeInstanceOf(Error);
      expect(closeWriter).toHaveBeenCalledTimes(1);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("destroys a live upload when the response transport closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-upload-storage-"));
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    }) as unknown as TrackedUploadRequest;
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const closeWriter = vi.fn();
    request[UPLOAD_REQUEST_DIRECTORY] = directory;
    request[UPLOAD_STAGING_RESERVATION] = {
      beginWriter: () => closeWriter,
    } as never;
    request[UPLOAD_RESPONSE_EVENTS] = response as never;
    const input = new PassThrough();
    const file = { stream: input } as unknown as Express.Multer.File;

    try {
      const callback = new Promise<unknown>((resolve) => {
        new SecureDiskStorage()._handleFile(request, file, (error) =>
          resolve(error),
        );
      });
      input.write(Buffer.alloc(1_024));
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.destroyed = true;
      response.emit("close");

      await expect(callback).resolves.toBeInstanceOf(Error);
      expect(closeWriter).toHaveBeenCalledTimes(1);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when Multer invokes storage without an admission reservation", () => {
    const request = {
      [UPLOAD_REQUEST_DIRECTORY]: "/fixture/request",
    } as TrackedUploadRequest;
    const callback = vi.fn();

    new SecureDiskStorage()._handleFile(
      request,
      { stream: new PassThrough() } as unknown as Express.Multer.File,
      callback,
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
    );
  });
});
