# Stage 1 manual cut — verification protocol

- Status: test design for the approved cut contract; no implementation implied
- Depends on: ADR-002, ADR-003, `RECOVERY-MANUAL-CUT.md`
- Fixture: `tmp/browser-smoke/source-6s.mp4` (H.264/AAC, 6 seconds), after it
  has an exact-version `CLEARED` authorization

## Purpose and evidence rule

This protocol turns the Stage 1 acceptance criteria into reproducible checks.
Tests must use a separate test database/bucket/prefix and a test Redis namespace.
They may inspect persisted rows and object keys through owned test adapters, but
must not add production HTTP diagnostics, worker commands, lease tokens, or
storage paths to the public API. A result is evidence only when the test records
the request/job IDs, state transitions, attempt numbers, artifact checksum and
the relevant structured event or test trace.

Every concurrent test uses a deterministic barrier exposed only by a fake port
or test fixture (for example `runtime.cutStarted`, `runtime.releaseCut`,
`storage.uploadStarted`, `clock.advance`). It must not depend on sleeps, polling
interval luck, or a human timing a process kill. Production uses its normal
clock, runtime and storage adapters.

## Testability seams required by the contract

The implementation may inject these narrow ports/configuration values into API,
worker and reconciliation composition. They are not public endpoints and their
defaults preserve production behavior.

| Seam                       | Test use                                                                        | Required observation                                |
| -------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `Clock`                    | advance retry, lease and admission deadlines without waiting                    | persisted due/expiry timestamps and state           |
| `MediaRuntime` fake        | block probe/cut, return duration/progress, fail or honour `AbortSignal`         | argv-free call record, signal aborted, output path  |
| storage fake/wrapper       | block or fail download/upload; enumerate only the test prefix; observe abort    | object-key intent, upload/delete calls, bytes       |
| queue adapter              | duplicate delivery, publish failure, Redis unavailable and later recovery       | only `{ jobId }` delivery; DB remains authoritative |
| scratch-capacity probe     | fixed usable capacity and reservation release                                   | reservation/queue reason without creating attempt   |
| worker lifecycle harness   | start/stop one real worker process and wait for an explicit ready/claimed event | PID exit, lease expiry and a later claim            |
| structured event collector | correlate API/job/attempt without exposing internals to the browser             | safe code and transition sequence                   |

Use an explicitly short lease, heartbeat and admission deadline only in the test
composition. The application default remains the documented 120 s / 30 s / 15
minutes. The worker must not import API controllers or test fixtures.

## API and authorization matrix

| Check                 | Setup and action                                                                                                 | Exact pass condition                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Create happy path     | `CLEARED` source; POST a valid range and fresh idempotency key                                                   | `202`; one `QUEUED` job stores unchanged tuple/range, recipe and fingerprint; queue receives one `jobId` reference                      |
| Range validation      | non-integers, missing fields, negative, equal/reversed, and `endMs > 2147483647`                                 | `400 INVALID_CUT_RANGE` or `VALIDATION_FAILED`; no job, attempt, artifact or queue reference                                            |
| Source duration truth | valid JSON range whose end exceeds the probe duration                                                            | API accepts intent; worker ends one attempt/job `FAILED_FINAL/CUT_OUT_OF_BOUNDS`; no ready artifact                                     |
| Gate fails closed     | source is `NOT_REVIEWED`, missing authorization, wrong version or wrong SHA                                      | media is `403 SOURCE_NOT_AUTHORIZED`; cut create is safe documented denial; no job or claim occurs                                      |
| Claim race            | create while clear, then make exact tuple non-cleared before deterministic claim barrier releases                | claim atomically records `SOURCE_NOT_AUTHORIZED`, creates no lease/runtime call and is never retried                                    |
| Idempotent request    | two concurrent identical POSTs, same key/body                                                                    | same job ID, one row/fingerprint and at most one queue reference; no duplicate attempt/artifact after worker runs                       |
| Key collision         | reuse a key with different timestamps                                                                            | `409 IDEMPOTENCY_CONFLICT`; original row and queue record unchanged                                                                     |
| Project ownership     | use a job ID belonging to project A under project B for get/download                                             | `404 CUT_JOB_NOT_FOUND`; no object metadata/read is attempted                                                                           |
| List stability        | create more than one page, retain returned cursor, insert a newer job, then request next page                    | newest-first pages have no duplicate/skip among the original snapshot; limit 1 and 100 work, 0/101/malformed cursor are rejected safely |
| Media ranges          | authorized known-size source and output: no Range, `0-9`, `10-`, suffix `-10`, malformed, multiple, and past-end | exact `200/206/416`, `Content-Length`, `Content-Range`, `Accept-Ranges`; HEAD has identical headers and no body                         |
| Stream cancellation   | open an authorized range, consume a first chunk, then destroy client stream at a storage barrier                 | storage stream receives abort/destroy; no full object is buffered or left open; API remains healthy                                     |
| Download readiness    | queued/running/failed job download; then succeeded job                                                           | not-ready is `409 CUT_NOT_READY`; ready is attachment with safe filename/type and streaming headers, never object key/path              |

The range integration test must use a storage stream whose read count fails if it
is asked for the whole object, so a buffered implementation cannot pass.

## Worker state, recovery and cleanup matrix

| Check                     | Deterministic procedure                                                                                                          | Exact pass condition                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single heavy slot         | queue two valid jobs, block first cut after claim                                                                                | exactly one `RUNNING` attempt/runtime cut; second stays visible `QUEUED`; release first then second claims                                                                |
| Scratch admission         | capacity below one reservation, then advance deadline; separately capacity permanently below source+output+margin                | first remains `QUEUED/SCRATCH_CAPACITY` with no attempt/retry then final `SCRATCH_ADMISSION_TIMEOUT`; second final `SCRATCH_CAPACITY_EXCEEDED`; both make no runtime call |
| Progress                  | fake runtime emits encoded ms out of order and transfer bytes                                                                    | persisted exposed progress is monotonic per phase with its actual denominator/unit; no invented overall percentage                                                        |
| Transient retry           | fail cut once with classified transient error; advance clock to due time                                                         | attempt 1 retryable, one bounded backoff, attempt 2 succeeds; no duplicate final artifact                                                                                 |
| Final media error         | probe invalid media and separately return duration below end                                                                     | stable `FAILED_FINAL/INVALID_SOURCE_MEDIA` or `CUT_OUT_OF_BOUNDS`; retry budget is not consumed again                                                                     |
| Duplicate queue delivery  | deliver the same `{ jobId }` concurrently while claim barrier is closed                                                          | one lease/attempt/runtime invocation; losing delivery has no state or artifact effect                                                                                     |
| Redis loss                | persist a queued job, make queue publish unavailable, restore Redis and run reconciler                                           | job remains visible in DB while Redis is down; reconciler republishes it and it succeeds once                                                                             |
| Worker crash and lease    | real worker blocks in controlled runtime, wait for claimed event, terminate that worker, advance past expiry, start a new worker | old attempt becomes `ABANDONED`; one later attempt succeeds; first process does not resume; exactly one winning artifact                                                  |
| Lease loss during I/O     | block cut or upload, advance clock/claim replacement so old heartbeat CAS loses, release old barrier                             | old runtime and storage receive abort; stale finalize is rejected; its attempt-specific object is marked cleanup-pending and never download-visible                       |
| Stale finalize            | retain old attempt/token/revision, complete a newer attempt first, then invoke old finalize                                      | old operation changes neither job state nor winning artifact; it schedules/deletes only its own object                                                                    |
| Crash after output intent | persist output key and cleanup intent, simulate termination before/during upload; run cleanup reconciler                         | every partial/orphan object in test prefix is HEAD-checked then deleted/retried until cleanup complete; scratch removed; source object untouched                          |
| Atomic success            | upload a valid cut, force CAS conflict just before success transaction                                                           | no `SUCCEEDED` job without a linked ready winning artifact and no linked ready artifact from losing attempt; conflict object enters cleanup                               |
| Retry exhaustion          | force retryable failure through the configured three attempts                                                                    | exactly three sequential attempts; final safe failure code; no runnable/leased duplicate remains                                                                          |

For each successful worker case, independently run FFprobe against the downloaded
MP4. It must contain video, be playable, and have duration within 100 ms of
`endMs - startMs`; record SHA-256 of both the stored artifact and downloaded
bytes and require equality.

## Browser and real-runtime smoke

Run this only after unit/integration tests have established the state machine.
Use the existing synthetic fixture and the pinned
`content-factory-media-runtime:node24.15.0-ffmpeg5.1.9` image; do not add a new
browser selector contract merely for this smoke.

1. Upload or reuse the fixture, obtain `CLEARED` through the explicit ADR-003
   flow, then open the ordinary project page. Capture the authorized source
   range-seek request and assert `206` plus exact headers.
2. Set two different valid ranges using the user-visible time controls. Create
   both jobs and wait by polling their documented job IDs/states, not a fixed
   delay. Each reaches `SUCCEEDED`, appears after reload in newest-first list,
   and downloads separately.
3. FFprobe both downloaded files and record duration/checksum evidence. The two
   object/job/artifact IDs and checksums must differ; neither download may be
   the source file.
4. Create a range within integer validation but beyond six seconds. Poll to the
   documented controlled `CUT_OUT_OF_BOUNDS` final failure. Confirm the UI
   shows only its safe error and the second valid job remains successful.
5. Preserve screenshots, browser network/console output, safe structured logs,
   FFprobe output and job-state JSON under ignored recovery evidence. Assert no
   page error and no object path, command, lease token or raw FFmpeg stderr is
   rendered.

## Required final command evidence

The delivery records the exact pinned runtime environment and successful output
for the relevant commands, followed by an independent real-diff review:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @content-factory/api test
pnpm --filter @content-factory/api test:integration
pnpm --filter @content-factory/web test
pnpm --filter @content-factory/api check:openapi
pnpm --filter @content-factory/web check:openapi
```

Add the worker package's build, lint, typecheck and test commands when that
package is introduced. The handoff must name migration version/counts, test
database and object-prefix isolation, image digest/tag, Redis-loss and
lease-recovery traces, retained cleanup state, rollback state, and any flaky or
environment-dependent observation. An implementer's report is not sufficient:
the reviewer reruns the high-risk matrix against the submitted diff.
