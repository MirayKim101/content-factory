# Recovery task: Stage 1 manual horizontal cut

- Status: approved contract; implementation pending
- Dependency: ADR-003 implemented and independently reviewed
- Ownership: one vertical-slice implementer; independent reviewer required

## 1. Пользовательский результат

Для сохранённой и `CLEARED` версии MP4 владелец открывает browser player, ставит
точные `startMs`/`endMs`, создаёт независимые cut jobs, видит их состояния и
скачивает MP4. Ошибка одного job не блокирует другие. HTTP API не запускает FFprobe/FFmpeg.

Не входят AI, Twitch, batches/multi-upload, overlays, metadata, publication, pause/cancel и замена source version.

## 2. Минимальный REST contract

All paths remain under `/api/v1/projects/{projectId}` and use generated OpenAPI:

- `GET|HEAD /source/media` streams the authorized source for `<video>`.
- `POST /cut-jobs`, with `Idempotency-Key` and JSON
  `{ "startMs": 1000, "endMs": 5000 }`, returns `202 CutJobDto`.
- `GET /cut-jobs?limit=20&cursor=...` returns a stable newest-first page after reload; `limit` is `1..100`.
- `GET /cut-jobs/{jobId}` returns one pollable `CutJobDto`.
- `GET|HEAD /cut-jobs/{jobId}/download` streams its ready output as an attachment; job IDs are project-scoped.

`startMs`/`endMs` are JSON/PostgreSQL integers, `0 <= startMs < endMs <= 2147483647`, stored unchanged. API validates
shape/order; the worker probes duration and rejects an out-of-bounds `endMs`.

Create checks `isCleared(sourceId, sourceVersion, sha256)` in the transaction that persists the job. Its fingerprint
includes project, exact source tuple, timestamps, type and `horizontal-cut-v1`. Identical key/fingerprint returns the
existing job without another enqueue; different content returns `409 IDEMPOTENCY_CONFLICT`.
Every listed read/create route checks the same exact source tuple; project status alone never grants media or cut access.

`CutJobDto` exposes `id`, exact source tuple/timestamps, state, stage, measured
phase progress (`current`, `total`, `unit`), attempts, queue reason, safe failure,
recipe/revision and optional ready artifact/download URL. It never exposes object
keys, worker IDs, lease tokens, commands or paths.

HTTP errors: `400 INVALID_CUT_RANGE|VALIDATION_FAILED`; `403 SOURCE_NOT_AUTHORIZED` for media reads; `404
PROJECT_NOT_FOUND|CUT_JOB_NOT_FOUND`; `409 SOURCE_NOT_READY|SOURCE_NOT_AUTHORIZED|IDEMPOTENCY_CONFLICT|CUT_NOT_READY`.

## 3. Safe byte-range media

Check authorization/readiness before storage metadata. Without `Range`, stream `200`; one valid `bytes=start-end`,
`bytes=start-`, or suffix returns `206` with exact `Content-Range`/`Content-Length`. Return `Accept-Ranges: bytes`, safe
type and sanitized disposition (`inline` source, `attachment` output). Malformed, multiple or unsatisfiable ranges
return `416` and `Content-Range: bytes */<size>`. `HEAD` mirrors headers; disconnect aborts stream; Nest never buffers MP4.

## 4. Authoritative job data and states

Add `PipelineJob` type `HORIZONTAL_CUT`, state `QUEUED|RUNNING|FAILED_RETRYABLE|SUCCEEDED|FAILED_FINAL`, source tuple;
idempotency fingerprint; recipe/revision; retry and admission deadlines; current
attempt; stage/phase progress; safe queue/failure fields; output artifact.

Add `JobAttempt`, unique `(jobId, attemptNumber)`, state `RUNNING|FAILED_RETRYABLE|FAILED_FINAL|SUCCEEDED|ABANDONED`; unique
lease token; start/heartbeat/expiry/finish times; reserved scratch; safe failure
and attempt-specific output intent. Extend `MediaArtifact.role` with
`HORIZONTAL_CUT` and link one winning artifact to its job while preserving
source ID/version, checksum and recipe lineage.

Keep `apps/api/prisma` as the sole schema/migration owner and add `apps/worker`
as a separate executable. Put only the new job state machine, repository port
and one Prisma persistence implementation in a narrow shared workspace package
consumed by API and worker. Do not move the existing schema/generated API client
or refactor unrelated upload persistence. Worker imports no API controller,
presentation module or HTTP use case; media and storage remain owned ports.

PostgreSQL is authoritative; BullMQ carries only `{ jobId }`. Persist before best-effort enqueue; failure stays visible
as `QUEUED` for reconciliation. Local heavy-media concurrency defaults to one configurable slot.

## 5. Claim, retry and recovery contract

Admission reserves source staging, predicted recipe output and a safety margin. Larger than usable scratch fails final
`SCRATCH_CAPACITY_EXCEEDED`; temporary pressure is visible `QUEUED / SCRATCH_CAPACITY`, with no attempt/retry consumed.
At the configurable deadline (local default 15 minutes) it fails final `SCRATCH_ADMISSION_TIMEOUT`.

Claim is one PostgreSQL CAS transaction over runnable state, due time, revision,
free slot, retry budget and exact `CLEARED` tuple. It creates the attempt and
lease, then marks the job `RUNNING`. Duplicate BullMQ delivery has one winner.
Default lease is 120 seconds with a 30-second heartbeat, both configurable.
Only the matching unexpired attempt/token/revision may heartbeat or finalize.
Heartbeat/CAS lease loss aborts the shared signal for child FFprobe/FFmpeg and
all storage transfers immediately, so a stale worker cannot consume resources
alongside its replacement claim.

An expired attempt becomes `ABANDONED`; the job becomes `FAILED_RETRYABLE` with
bounded exponential backoff or `FAILED_FINAL` when its default three-attempt
budget is exhausted. Reconciler scans due queued/retryable jobs and expired
leases, and republishes references after worker restart or total Redis loss.

Source authorization is checked again in the claim transaction. Failure creates
no execution lease and atomically terminates the job with
`SOURCE_NOT_AUTHORIZED`; it is not retried. A stale attempt can neither update
job state nor attach/replace an artifact. Attempt-specific object keys prevent
overwrite; losing, partial and orphan outputs enter cleanup and scratch is
removed in `finally` without touching the source artifact.
Persist the attempt object key and cleanup intent before upload. A reconciler
HEAD-checks and deletes pending objects after crashes until cleanup is recorded
complete; in-memory `finally` is only the immediate fast path.

Controlled final failures include `CUT_OUT_OF_BOUNDS`, `INVALID_SOURCE_MEDIA`
and `SOURCE_NOT_AUTHORIZED`. Storage/transient process failures and
`MEDIA_TIMEOUT` are retryable within budget. Exhaustion is `FAILED_FINAL` with a
stable safe code; raw stderr and private paths never reach API responses.

## 6. Dependency-neutral media execution

The worker owns a `MediaRuntime` port:

```text
probe({ inputPath, signal }) -> { durationMs, streams }
cut({ inputPath, outputPath, startMs, endMs, recipe, signal, onProgress })
```

The initial adapter spawns configured FFprobe/FFmpeg binaries with argv arrays,
never a shell or user-built command. It bounds captured output, supports timeout
and abort, and accepts only owned recipe values. The same port runs locally or
inside a later DevOps-provided worker image; application code does not invoke
Docker, mount its socket, or select an image. The image contract is only
configured binary paths, non-root execution, writable isolated scratch and a
version probe. Runtime/image pinning is a separate DevOps delivery.

`horizontal-cut-v1` re-encodes for accurate boundaries. During encoding the
adapter parses FFmpeg machine progress and stores monotonic encoded milliseconds
over requested duration; each transfer may report measured bytes over total.
Stages without a measurable denominator are indeterminate. No weighted overall
percentage is invented. After cut, FFprobe confirms MP4/video and duration within
the recipe tolerance (at most 100 ms for the fixture), then SHA-256 is calculated
and the attempt-specific artifact is uploaded. Artifact-ready and job-success
commit together under active lease CAS; failed CAS schedules object cleanup.

## 7. UI and acceptance evidence

The player has “set start/end” buttons using rounded `currentTime * 1000`,
human-readable editable `HH:MM:SS.mmm` (or seconds) fields and an independent
job list. Parsing produces the exact integer milliseconds sent through REST.
Vue Query shows server state, admission reason/deadline and measured phase progress.

Required evidence:

1. Contract/integration tests cover auth, idempotency, pagination, ownership, `200/206/416`, HEAD and disconnect.
2. Worker tests with a controllable runtime/clock prove bounded slot, visible
   scratch wait/deadline, measured phase progress, out-of-bounds failure,
   transient retry, lease expiry, duplicates, stale-finalize rejection, cleanup
   and one winning artifact.
3. Stop Redis after persistence, restart Redis/worker, and show DB reconciliation. Kill a blocked worker, expire its
   lease, restart, and show recovery without duplicate output.
4. Browser smoke with a small real H.264 MP4: Range seek, two independent cuts/downloads, checksum and FFprobe duration;
   repeat out-of-bounds and record safe failure/logs.
5. Run format, lint, typecheck, all tests, API integration/OpenAPI drift and worker checks; hand off migration counts,
   commands, logs, smoke artifacts, rollback and independent real-diff review.

Rollback stops new cut creation and claims, lets an active lease finish or expire,
and leaves job/attempt/artifact rows for audit. The additive schema stays; ready
objects follow retention. Source upload and authorization continue independently.
