# Manual-cut worker runtime

Verified configuration target: 2026-09-09

The Stage 1 worker is an opt-in local Compose service. It consumes persisted
manual-cut jobs only after it can connect to PostgreSQL, complete its first
reconciliation, and create a readiness marker. Do not start it against the
retained local database until the API migration, generated-client checks, and
manual-cut application checks have passed and the orchestrator has opened the
ready gate.

## Image

`content-factory-worker:node24.15.0-ffmpeg5.1.9` is built from the reviewed
`content-factory-media-runtime:node24.15.0-ffmpeg5.1.9` base. That base pins
Node.js `24.15.0` and Debian Bookworm FFmpeg `7:5.1.9-0+deb12u1`; see
[media-runtime.md](media-runtime.md).

The worker build uses the committed lockfile with `pnpm install
--frozen-lockfile`, then compiles the sole API-generated Prisma source through
`@content-factory/prisma-client`, followed by `@content-factory/manual-cut` and
`@content-factory/worker`. Its runtime command is:

```text
node apps/worker/dist/main.js
```

The final image contains only that compiled worker, its compiled workspace
dependencies, and production dependencies. It has no Docker CLI/socket, host
source mount, exposed port, or root process.

## Build and configuration validation

1. From the repository root, confirm the local configuration without displaying
   any secret values:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml config --quiet
   docker compose --env-file .env -f infrastructure/compose.yaml --profile worker config --quiet
   ```

   The expected result is no output and exit code `0` from each command.

2. Build only the worker image:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml --profile worker build worker
   ```

   Docker should report a successful build of
   `content-factory-worker:node24.15.0-ffmpeg5.1.9`. This command does not start
   a worker or change PostgreSQL, Redis, MinIO, or existing application services.

The profile supplies internal Compose hostnames (`postgres`, `redis`, `minio`),
the bucket-scoped S3 credentials already used by the application, the pinned
FFmpeg paths, and the conservative local defaults: one heavy job,
120-second lease, 30-second heartbeat, 15-minute API admission deadline,
three attempts, and a two-hour media timeout. The worker directly validates the
values it consumes. Admission timeout and attempts are persisted by the API when
it creates a job; they are not worker overrides.

The local MinIO identity is limited to source objects under `sources/*` and
manual-cut objects under `projects/*/cuts/*`. It has no access to other bucket
prefixes. Re-run only the `minio-init` provisioning service after a reviewed
policy change; do not recreate the MinIO data volume.

## Start after the ready gate

1. After the orchestrator opens the ready gate, start the worker profile only:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml --profile worker up --detach worker
   docker compose --env-file .env -f infrastructure/compose.yaml --profile worker ps worker
   ```

2. The expected result is `running` and `healthy`. The health check requires
   the worker's own readiness marker, written only after database connection and
   first successful reconciliation and BullMQ readiness. Logs are one JSON object per line; look for an event
   whose `event` value is `worker_ready`:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml --profile worker logs --tail 50 worker
   ```

The container runs as UID/GID `1000`, drops all Linux capabilities, forbids new
privileges, uses a read-only root filesystem, and has a 64 MiB non-executable
`/tmp`. Only `worker-scratch` is writable. Its readiness marker is removed by
the entrypoint before every process start, so an ungraceful previous container
cannot appear healthy from a stale marker.

`worker-scratch` is persistent only to preserve crash-recovery scratch state;
it is not a media backup. PostgreSQL and MinIO remain the authoritative metadata
and artifact stores. Back up those named volumes with the database and object
storage procedures before retained-data operations. Never back up or copy the
local `.env` as part of a container image or source archive.

## Stop and rollback

Stop new claims by stopping only this service:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml --profile worker stop worker
```

If the BullMQ consumer stops unexpectedly, the process removes this marker,
closes its queue, database and storage connections, and exits nonzero so the
Compose restart policy can recover it. A failed initial reconciliation never
starts consumption or creates the marker.

The worker receives `SIGTERM`, removes its readiness marker, and closes its
queue, database, and storage connections. Follow the manual-cut recovery
contract: let an active lease finish or expire, then use reconciliation when a
reviewed compatible worker starts again. Do not remove PostgreSQL, Redis, MinIO,
or their volumes as a worker rollback step.

To return to the previous local runtime state, leave the additive job data and
artifacts in place, keep the worker stopped, and run the prior compatible API
release that preserves the job records. The image can be rebuilt from this
Dockerfile after a reviewed correction; do not prune shared Docker images or
volumes.
