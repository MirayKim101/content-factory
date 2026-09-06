import { Readable } from "node:stream";

import type {
  MediaProcessor,
  SourceCache,
  WorkerObjectStorage,
} from "../../src/application/ports.js";
import { ProcessMediaJob } from "../../src/application/process-media-job.js";
import { PgMediaJobRepository } from "../../src/infrastructure/pg-media-job.repository.js";
import { StreamingZip64PackageExporter } from "../../src/infrastructure/streaming-zip64-package-exporter.js";

const [databaseUrl, jobId, scratchDirectory, videoBase64, thumbnailBase64] =
  process.argv.slice(2);
if (
  !databaseUrl ||
  !jobId ||
  !scratchDirectory ||
  !videoBase64 ||
  !thumbnailBase64
) {
  throw new Error("EXPORT_HARD_CRASH_FIXTURE_ARGUMENTS_REQUIRED");
}

const repository = new PgMediaJobRepository(databaseUrl, "local-auto");
const video = Buffer.from(videoBase64, "base64");
const thumbnail = Buffer.from(thumbnailBase64, "base64");
const storage: WorkerObjectStorage = {
  read: async (objectKey) =>
    Readable.from([objectKey.includes("/render-") ? video : thumbnail]),
  download: async () => {
    throw new Error("UNUSED_DOWNLOAD");
  },
  upload: async (): Promise<{ etag?: string; version?: string }> => {
    process.stdout.write("PREUPLOAD\n");
    await new Promise<never>(() => undefined);
    return {};
  },
  delete: async () => undefined,
  close: () => undefined,
};
const sourceCache = {
  acquire: async () => {
    throw new Error("UNUSED_SOURCE_CACHE");
  },
  close: async () => undefined,
} as unknown as SourceCache;
const processor = {} as MediaProcessor;

await new ProcessMediaJob(
  repository,
  storage,
  processor,
  sourceCache,
  "hard-crash-worker",
  {
    scratchDirectory,
    scratchSafetyBytes: 0n,
    leaseMs: 30_000,
    jobTimeoutMs: 60_000,
  },
  () => undefined,
  undefined,
  new StreamingZip64PackageExporter(),
).execute(jobId);
