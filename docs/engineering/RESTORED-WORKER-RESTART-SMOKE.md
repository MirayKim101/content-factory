# Restored worker restart smoke — 2026-09-16

## Scope

This is a local failure-recovery check for the isolated Mac-baseline runtime.
It uses a new synthetic source, project, and cut only. The only container ever
stopped is the one whose Docker labels prove it is
`content-factory-restored` / `media-worker`; API and web processes remain up.
It does not connect to a legacy database, queue, bucket, volume, container, or
external provider.

The relevant runtime configuration remains unchanged: one worker slot,
`MEDIA_JOB_LEASE_MS=30000`, a five-second API reconciliation interval, and
`AI_CONTEXT_ENABLED=0`. ADR-002 makes PostgreSQL authoritative for the job
lease and requires duplicate delivery to have no repeated effect; Redis/BullMQ
is only delivery coordination.

## Reproducible exercise

Run from the repository root while the documented restored runtime, API, and
local web proxy are already healthy:

```sh
sh tmp/restored-runtime/restart/exercise-worker-restart.sh
```

The ignored script first checks the exact Compose labels for the new worker and
PostgreSQL container. It creates a 30-second, 1920×1080 synthetic H.264/AAC
source inside that worker, uploads it through the local API, waits for source
readiness, and asks for one 28-second cut. Once PostgreSQL reports
`PROCESSING`, it records the attempt state, force-terminates only that worker,
then starts the same Compose service and waits for health.

The script gives each source/cut readiness phase at most two minutes. It waits
through lease expiry and reconciliation, then verifies a terminal result after
an additional delayed GET. It compares the downloaded bytes with the API
SHA-256, uses worker FFprobe for duration, and queries the isolated PostgreSQL
row without printing credentials. Its evidence stays under the ignored
`tmp/restored-runtime/restart` directory.

## Completed run

The completed synthetic fixture was project
`66e6793f-73fc-42b6-ab9f-4e95dcfbe9f4`, cut job
`8fdbf73c-70d1-4551-a4e4-0fca57b83572`.

Before the forced stop, the durable row was `PROCESSING`, attempt `1`, with no
result artifact. After the new worker became healthy, API reconciliation marked
attempt 1 `FAILED_RETRYABLE` with `WORKER_LEASE_EXPIRED`; attempt 2 reached
`READY`.

| Check                                         | Result                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Job state and attempt count                   | `READY`, `2`                                                                     |
| Persisted READY result artifacts for this job | exactly `1`                                                                      |
| Attempts                                      | 1 `FAILED_RETRYABLE` / `WORKER_LEASE_EXPIRED`; 2 `READY`                         |
| Result SHA-256, API versus downloaded bytes   | `f9caf5b4ec07354183c8cdd44b41054b6fb798acf84d5e417ccbbefa4ecd5dac`               |
| FFprobe duration                              | `28.000000` seconds, within 27.75–28.25 second bound                             |
| Worker after exercise                         | project `content-factory-restored`; service `media-worker`; `running`, `healthy` |
| API health after exercise                     | `{"status":"ok"}`                                                                |

The worker log records a delivery replay that made no effect while the old
attempt was no longer runnable, followed by the claimed attempt 2 and one
successful encode/upload/finalization. The final PostgreSQL assertion requires
one `MediaArtifact`, one READY attempt, and exactly the expected two-attempt
sequence, so a duplicate finalization or replay mutation fails the exercise.

## Result and limits

This is evidence that a forced worker loss during a real isolated cut recovers
through the configured lease path and leaves one valid final artifact. It does
not prove recovery for every media type, simultaneous workers, Redis loss, or a
crash after object upload; those need their own controlled scenarios. No
production code, lease duration, API/web process, or runtime configuration was
changed for this check.

## Independent reproduction

The orchestrator inspected the actual harness and independently reran the full
forced-restart exercise with an outer 300-second timeout. It passed on a second
fresh project `b3ba6c87-52e4-4773-8b69-fccacf2b3b31`, job
`90a42b66-f834-440e-a411-3b1b7b119eb2`: two attempts, one READY result, the same
SHA-256 above and duration 28.000000 seconds. After the exercise the label-verified
restored worker was running/healthy and API health returned ok. Independent
verdict: CLEAN for this bounded recovery scenario. Logs:
`tmp/recovery/restored-restart-independent.log`. The reusable harness evidence
files now describe this second run; the first fixture remains in the isolated DB.
