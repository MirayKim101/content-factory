# Independent manual-cut review — 2026-09-09

## Verdict

**Delivery acceptance: NOT ACCEPTED.** The final diff has no known open HIGH or
MEDIUM correctness defect after the fixes below, and the normal path plus two
real recovery paths pass. However, the approved
`RECOVERY-MANUAL-CUT-VERIFICATION.md` matrix still has mandatory cases that were
not reproduced literally. This report does not waive those gates.

The reviewed scope stays within Stage 1: exact manual timestamps, persisted
PostgreSQL intent, recoverable BullMQ references, background FFmpeg processing,
status, controlled failure and download. HTTP handlers do not perform media
processing. The API and worker use the same neutral generated Prisma client;
the API still owns one `PrismaService` instance.

## Material findings resolved during review

1. Scratch reconciliation originally omitted crash-left staging directories,
   then could delete a directory that became live after enumeration. It now
   removes only UUID directories confirmed terminal by PostgreSQL, in bounded
   batches.
2. Scratch reservation and the heavy slot were process-local. Claim now uses a
   PostgreSQL transaction and advisory lock to serialize global slot and
   reservation admission against observed usable capacity.
3. Progress writes could regress or interpret a stale update as lease loss.
   The repository now performs a monotonic lease/revision/current-attempt CAS
   and treats rejected stale progress as benign while the lease is still live.
4. Create replay, claim authorization and retry/finalization races were
   tightened around the immutable source tuple and lease revision. A replay
   uses the persisted tuple; claim locks and rechecks source plus authorization;
   stale finalization cannot create a second artifact.
5. Output cleanup originally included live upload intents and storage cleanup
   could block indefinitely. Cleanup now selects only terminal attempts and
   bounds HEAD/DELETE; output intent is persisted before upload.
6. Worker startup originally opened consumption before initial reconciliation,
   and an unexpected consumer failure could leave readiness behind. Initial
   reconciliation is fail-closed, BullMQ readiness precedes the ready marker,
   and a rejected consumer run removes readiness and exits nonzero.
7. A successful DB commit emitted telemetry before clearing the local output
   cleanup guard. A throwing sink could delete the winning object. Telemetry is
   now best-effort and the guard is cleared before the success event; a
   throwing-sink regression covers it.
8. Any nonzero `ffprobe` exit was retryable. Ordinary probe failure now becomes
   final `INVALID_SOURCE_MEDIA`, while timeout remains retryable; adapter tests
   cover both.
9. Worker and API multipart upload adapters could miss a caller signal already
   aborted just before listener registration. Registration is now followed by
   an `aborted` check, closing that race.
10. The first real worker run exposed a cut-prefix storage-policy omission.
    Provisioning now permits only the required cut object prefix in addition to
    the existing source prefix; allow/deny probes and the later real cuts pass.

No material finding remained open in the final read-only pass over the job
repository, worker state machine, FFmpeg/S3 adapters, lifecycle, REST streaming,
OpenAPI contract, frontend intent handling, migration and packaging boundary.

## Independently reproduced evidence

### Focused checks after the final fixes

Using Node 24.15.0 and the repository-local pnpm runtime:

- `pnpm --filter @content-factory/manual-cut test`: 1 file, 9 tests passed.
- `pnpm --filter @content-factory/worker test`: 2 files, 5 tests passed.
- API `media-range.spec.ts`: 1 file, 10 tests passed. Its new blocked stream
  check observes the storage signal abort and stream destruction on client
  disconnect without consuming bytes.
- API `media-range.spec.ts` plus `cut-job.service.spec.ts`, before the final
  barrier additions: 2 files, 10 tests passed.
- A unique isolated PostgreSQL database received all four migrations and the
  cut repository suite passed 7/7. A temporary trigger forced failure on the
  final job update after artifact insertion; the transaction left zero artifact
  rows for that ID and kept the job `RUNNING` without a winner. The database was
  force-dropped by a shell trap, and `pg_database` confirmed count zero.

The implementer/root separately reported dependency-ordered generate/build,
format, lint, typecheck, OpenAPI drift, API 44-unit, web 39-unit, manual-cut
9-unit, worker 5-unit and API integration 4-file/22-test passes. Those results
are supporting evidence; they are not represented here as independently rerun
where the reviewer did not run them.

### Real worker crash and lease recovery

Before mutation, all retained jobs were terminal and a custom PostgreSQL dump
was saved as `tmp/recovery/before-manual-cut-crash-protocol.dump`, mode `0600`,
with a successful container `pg_restore --list` check. Only the owned local
worker used test overrides (`CUT_LEASE_MS=3000`, `CUT_HEARTBEAT_MS=500`).

Job `aff7d8c4-69ff-4a80-ab9d-3b4bed56a3bf` was paused immediately after its
structured `cut_claimed` event, while PostgreSQL recorded attempt 1 as
`RUNNING/SOURCE_DOWNLOAD`, then the worker was killed with SIGKILL. A replacement
worker recovered the expired lease:

- attempt 1 `5720f7b0-6012-4dd2-b205-a3310b048a99` became
  `ABANDONED/LEASE_EXPIRED`;
- attempt 2 `c0dda138-3a67-470d-9423-ce077fa4b1e7` became `SUCCEEDED`;
- the job has exactly one ready winning artifact and one distinct object key;
- download and artifact SHA-256 both equal
  `0569821861028914120c6737b135410e51ca05e4a7bdca612c4a8a77f86936fb`;
- FFprobe reports 4.000 seconds and 227101 bytes;
- both attempt scratch directories are absent.

This process kill used a structured-event watcher rather than a deterministic
test harness, so it proves the real runtime recovery path but remains dependent
on local timing.

### Redis loss after persisted intent

With worker and Redis stopped, POST with unique idempotency key
`redis-loss-1788961512194` returned 202 for job
`ccb1e411-d04c-4560-8c52-f2ac3bdb315b`. While Redis was unavailable, PostgreSQL
showed `QUEUED`, `attemptCount=0`, no attempt and no winning artifact. No queue
or database-wide flush/delete was used.

After Redis and worker restart, startup reconciliation completed the job once:

- one `SUCCEEDED` attempt, one artifact and one distinct object key;
- download and artifact SHA-256 both equal
  `74828f42ae8076be8d174a4710d33dce7b05bd84b10f90cc2bf3a079a214c252`;
- FFprobe reports 3.000 seconds and 168774 bytes;
- the attempt scratch directory is absent.

All jobs were terminal afterward. The worker was recreated with the production
defaults `CUT_LEASE_MS=120000` and `CUT_HEARTBEAT_MS=30000` and reached healthy.
Evidence JSON, FFprobe output and filtered structured logs are under ignored
`tmp/recovery/manual-cut-{crash,redis}-*` files.

### Other durable evidence reviewed

- `RECOVERY-MANUAL-CUT-SMOKE.md` records real REST Range/HEAD, two valid cuts,
  idempotent replay/conflict, controlled out-of-bounds failure, downloads,
  FFprobe and browser reload with no JavaScript errors.
- `RECOVERY-MANUAL-CUT-MIGRATION-REPAIR.md` records the guarded unpublished
  migration checksum reconciliation. Exact original bytes matched the retained
  migration row; isolated clean install and forced rollback passed; normalized
  schema and business-row counts were unchanged by the metadata-only repair.
- The seven-case real-PostgreSQL repository suite covers concurrent duplicate
  claim, global scratch reservation, lease expiry, monotonic progress, terminal
  cleanup selection, source authorization at claim, exact retry exhaustion and
  rejection of a stale finalizer with one winning artifact. The isolated rerun
  additionally proves artifact insertion rolls back when final job persistence
  fails.
- Shared worker tests now cover a blocked upload that observes lease-loss abort,
  invokes no completion, and HEAD-checks/deletes only its attempt key. A separate
  reconciliation test proves successful pending cleanup calls HEAD, DELETE and
  completion for the exact recorded key.

## Mandatory verification still missing

The following approved matrix rows lack their exact deterministic or integration
proof and therefore block acceptance:

1. A source-authorization mutation racing a claim at a deterministic barrier;
   the current test mutates first and claims afterward.
2. Two concurrent identical API POSTs proving one persisted job and at most one
   queue reference. Repository claim concurrency and sequential service enqueue
   behavior are covered separately.
3. Project-scoped get/download denial with an assertion that storage metadata
   and reads are untouched.
4. Multi-page cursor stability across insertion of a newer job.
5. Temporary scratch pressure through admission deadline, plus a deterministic
   single-heavy-slot release sequence. Impossible-capacity and transactional
   reservation cases pass, but these exact paths do not.
6. One classified transient media/storage failure followed by a successful
   retry. Exact three-attempt exhaustion and lease-expiry recovery pass.
7. Lease loss caused by a deterministic clock advance and replacement claim
   while cut/upload is blocked, followed by release of the stale operation. The
   new upload test proves abort and exact-key cleanup, but it obtains lease loss
   from a one-millisecond heartbeat timer and does not exercise replacement-claim
   CAS as the approved protocol specifies.
8. Crash after output intent, before/during upload, followed by reconciliation
   of that exact orphan. Real cleanup of six denied cut uploads and bounded
   exact-key cleanup unit coverage are useful but are not this crash case.

The final bounded additions closed stream cancellation and atomic-success
rollback, and materially strengthened lease-loss and cleanup evidence. Until
the remaining required rows are either reproduced or the approved verification
document is explicitly amended by an independent architect, this slice remains
reviewable work in progress rather than accepted MVP delivery.

## Recovery and rollback notes

PostgreSQL is authoritative and Redis may be recreated without deleting job
rows. Do not run an older API against the additive cut schema. Keep the verified
pre-repair and pre-crash dumps until the slice is accepted. A rollback should
first stop API and worker writers, preserve newer rows/objects, and use a
separately reviewed forward or restore plan; blindly dropping the new tables or
restoring an older dump can lose cut history and newer source records.
