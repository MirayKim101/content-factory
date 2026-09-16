import { randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(import.meta.dirname, "../.env");

try {
  await access(output);
  throw new Error("REFUSING_TO_OVERWRITE_EXISTING_ENV");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function secret() {
  return randomBytes(32).toString("base64url");
}

const values = {
  POSTGRES_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),
  MINIO_ROOT_PASSWORD: secret(),
  S3_SECRET_KEY: secret(),
};

const content = `# Generated for the isolated restored runtime on ${new Date().toISOString()}.
# This file is private, mode 0600, and intentionally ignored by Git.
DEPLOYMENT_PROFILE=local
SOURCE_AUTHORIZATION_POLICY=local-auto
API_HOST=127.0.0.1

POSTGRES_DB=content_factory_restored
POSTGRES_USER=content_factory_restored
POSTGRES_PASSWORD=${values.POSTGRES_PASSWORD}
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=15432

REDIS_HOST=127.0.0.1
REDIS_PORT=16379
REDIS_PASSWORD=${values.REDIS_PASSWORD}
MEDIA_QUEUE_NAME=content-factory-restored-media-v1

MINIO_ROOT_USER=content-factory-restored-root
MINIO_ROOT_PASSWORD=${values.MINIO_ROOT_PASSWORD}
S3_ENDPOINT=http://127.0.0.1:19000
S3_REGION=us-east-1
S3_SOURCE_BUCKET=content-factory-restored-sources
S3_ACCESS_KEY=content-factory-restored-api
S3_SECRET_KEY=${values.S3_SECRET_KEY}
S3_OPERATION_TIMEOUT_MS=7200000
S3_STARTUP_TIMEOUT_MS=5000

API_MAX_UPLOAD_BYTES=10737418240
API_UPLOAD_TEMP_DIRECTORY=tmp/restored-runtime/uploads
API_UPLOAD_TEMP_STALE_AFTER_MS=300000
API_UPLOAD_TEMP_SWEEP_LIMIT=100
SOURCE_PENDING_STALE_AFTER_MS=300000
SOURCE_PENDING_RECONCILE_LIMIT=25
SOURCE_PENDING_STARTUP_TIMEOUT_MS=5000
MEDIA_RECONCILE_INTERVAL_MS=5000
MEDIA_RECONCILE_LIMIT=100

ASSEMBLY_RENDER_ENABLED=1
EDITORIAL_APPROVAL_ENABLED=1
EDITORIAL_EXPORT_ENABLED=0
AI_CONTEXT_ENABLED=0

MEDIA_WORKER_CONCURRENCY=1
MEDIA_JOB_LEASE_MS=30000
MEDIA_JOB_TIMEOUT_MS=7200000
MEDIA_SCRATCH_DIRECTORY=tmp/media-worker
MEDIA_SCRATCH_SAFETY_MIB=1024
MEDIA_SOURCE_CACHE_DIRECTORY=tmp/media-cache
MEDIA_SOURCE_CACHE_MAX_MIB=12288
MEDIA_SOURCE_CACHE_TTL_MS=21600000
MEDIA_SCRATCH_SIZE=24g
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
FFMPEG_THREADS=2
ASSEMBLY_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
`;

await writeFile(output, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
await chmod(output, 0o600);
process.stdout.write(
  "created isolated restored runtime .env (secrets withheld)\n",
);
