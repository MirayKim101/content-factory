import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { StorageEngine } from "multer";

import {
  isUploadStagingFilesystemError,
  UploadStagingUnavailableException,
  type UploadStagingReservation,
} from "./upload-staging-admission.service.js";

interface StoredFileInfo {
  destination: string;
  filename: string;
  path: string;
  size: number;
}

export class SecureDiskStorage implements StorageEngine {
  _handleFile(
    request: Express.Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    const trackedRequest = request as TrackedUploadRequest;
    const directory = trackedRequest[UPLOAD_REQUEST_DIRECTORY];
    const reservation = trackedRequest[UPLOAD_STAGING_RESERVATION];
    if (!directory || !reservation) {
      callback(new UploadStagingUnavailableException());
      return;
    }
    void this.writeFile(request, file, directory, reservation)
      .then((info) => callback(undefined, info))
      .catch((error: unknown) => callback(error));
  }

  _removeFile(
    _request: Express.Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    if (!file.path) {
      callback(null);
      return;
    }
    void rm(file.path, { force: true })
      .then(() => callback(null))
      .catch((error: Error) => callback(error));
  }

  private async writeFile(
    request: Express.Request,
    file: Express.Multer.File,
    directory: string,
    reservation: UploadStagingReservation,
  ): Promise<StoredFileInfo> {
    const filename = randomUUID();
    const path = join(directory, filename);
    const closeWriter = reservation.beginWriter();
    let size = 0;
    let output: ReturnType<typeof createWriteStream> | undefined;
    let abortError: Error | undefined;
    const requestEvents = request as unknown as AbortableRequest;
    const responseEvents = (request as TrackedUploadRequest)[
      UPLOAD_RESPONSE_EVENTS
    ] as unknown as AbortableResponse | undefined;
    const abortTransfer = (): void => {
      if (!abortError) abortError = new Error("UPLOAD_TRANSPORT_ABORTED");
      file.stream.destroy(abortError);
      output?.destroy(abortError);
    };
    try {
      output = createWriteStream(path, { flags: "wx", mode: 0o600 });
      file.stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      const completed = pipeline(file.stream, output);
      if (
        requestEvents.aborted ||
        requestEvents.destroyed ||
        responseEvents?.destroyed
      ) {
        abortTransfer();
      } else {
        requestEvents.once("aborted", abortTransfer);
        responseEvents?.once("close", abortTransfer);
      }
      await completed;
      return { destination: directory, filename, path, size };
    } catch (error) {
      try {
        await rm(path, { force: true });
      } catch {
        // Preserve the stream failure for the HTTP exception mapper.
      }
      if (isUploadStagingFilesystemError(error)) {
        throw new UploadStagingUnavailableException();
      }
      throw error;
    } finally {
      requestEvents.removeListener("aborted", abortTransfer);
      responseEvents?.removeListener("close", abortTransfer);
      closeWriter();
    }
  }
}

export const UPLOAD_REQUEST_DIRECTORY = Symbol("UPLOAD_REQUEST_DIRECTORY");
export const UPLOAD_STAGING_RESERVATION = Symbol("UPLOAD_STAGING_RESERVATION");
export const UPLOAD_RESPONSE_EVENTS = Symbol("UPLOAD_RESPONSE_EVENTS");

export type TrackedUploadRequest = Express.Request & {
  [UPLOAD_REQUEST_DIRECTORY]?: string;
  [UPLOAD_STAGING_RESERVATION]?: UploadStagingReservation;
  [UPLOAD_RESPONSE_EVENTS]?: Express.Response;
};

interface AbortableRequest {
  aborted?: boolean;
  destroyed?: boolean;
  once(event: "aborted", listener: () => void): void;
  removeListener(event: "aborted", listener: () => void): void;
}

interface AbortableResponse {
  destroyed?: boolean;
  once(event: "close", listener: () => void): void;
  removeListener(event: "close", listener: () => void): void;
}
