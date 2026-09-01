import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { StorageEngine } from "multer";

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
    const directory = (request as TrackedUploadRequest)[
      UPLOAD_REQUEST_DIRECTORY
    ];
    if (!directory) {
      callback(new Error("UPLOAD_TEMP_DIRECTORY_NOT_INITIALIZED"));
      return;
    }
    void this.writeFile(file, directory)
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
    file: Express.Multer.File,
    directory: string,
  ): Promise<StoredFileInfo> {
    const filename = randomUUID();
    const path = join(directory, filename);
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    let size = 0;
    file.stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        file.stream.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        file.stream.pipe(output);
      });
      return { destination: directory, filename, path, size };
    } catch (error) {
      output.destroy();
      await rm(path, { force: true });
      throw error;
    }
  }
}

export const UPLOAD_REQUEST_DIRECTORY = Symbol("UPLOAD_REQUEST_DIRECTORY");

export type TrackedUploadRequest = Express.Request & {
  [UPLOAD_REQUEST_DIRECTORY]?: string;
};
