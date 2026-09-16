# Stage 2B-2 implementation checkpoint

Date: 2026-09-16. Contract authority:
`tasks/stage2b-sparse-frame-evidence.md` and
`SPARSE-FRAME-CONTRACT-REVIEW.md`. This document records implementation evidence;
the orchestrator's independent review and live acceptance determine completion.

## Behavior and ownership

AI Content owns immutable frame intents, exact captured context identity,
attempts, three attempt outputs, one accepted result and its three frames.
`MediaArtifact` keeps its existing one-result-per-job invariant. The existing
module-wide `AiContentOperationRequest` ledger also owns frame requests; reuse
of a creator-profile key for a frame operation conflicts.

POST admission requires both `AI_CONTEXT_ENABLED=1` and
`EDITORIAL_FRAMES_ENABLED=1`; the new flag defaults off. Historical detail,
list and content do not depend on admission flags. Metadata separates current
generation eligibility from private byte authorization. Reference photographs
and reference authorization changes are not frame inputs or fingerprint facts.

The API and media worker use separate transaction-aware adapters and a shared
pure policy evaluator. Admission, claim, pre-read and final acceptance use
serializable transactions and the frozen row-lock order. A pre-read marker
captures the admitted fingerprint before the first input byte. The API retries
recognized Prisma serialization errors including raw-query `P2010` wrapping
SQLSTATE `40001` or `40P01`; unrelated errors are not silently retried.

The worker owns a PostgreSQL `FRAME_EXTRACTION` pool with
`FRAME_EXTRACTION_CAPACITY=1` by default (valid range 1–16). Replicas must agree
with its durable configured capacity. `FRAME_WORK_DEADLINE_MS` defaults to
300000, bounded to 60000–1800000. Every FFmpeg/FFprobe invocation receives the
remaining immutable deadline through OS `timeout`, TERM followed by KILL within
10 seconds. Missing watchdog or an unsupported FFmpeg version fails startup.
PostgreSQL timestamp values and deadline writes use explicit UTC semantics,
independent of workstation timezone.

The worker verifies exact cut bytes and hash, samples three quartiles without
input seeking, normalizes selected timestamps to AVTB and stores measured PTS.
JPEG output uses bounded display-space geometry, square SAR and Lanczos; outputs
whose even-pixel rounding exceeds 1% display-aspect error are unsupported.
Each image is probed and fully decoded before hashing. Extractor provenance is
`ffmpeg-frame-extractor-v1`, distinct from the evidence and recipe versions.

## Failure, recovery and cleanup

Scratch and slot deferral set a visible reason and next-attempt time without
consuming an attempt. Local bytes and a unique directory name are reserved before
claim; the directory is created exclusively only after the claim has durably
persisted its owner. Pending, rejected or unknown claims create no scratch.
Job/slot heartbeat renews atomically and never extends the
work deadline. The legacy media lease reconciler explicitly excludes frame
jobs; durable reference-only redispatch still reaches the owned frame gate so a
revoked source becomes a controlled failure instead of remaining queued forever.

An execution-stopped fence is written only after children and pending input or
output promises have settled. A confirmed stop before deadline permits bounded
retry. A vanished owner does not free a slot at lease expiry; after deadline plus
30 seconds, recovery frees the slot and records terminal
`FRAME_WORK_DEADLINE_EXCEEDED`. A new explicit request/key is required afterward.
This is controlled crash recovery, not transparent retry with an extended budget.

Every upload has a durable exact attempt key before I/O. Final acceptance and
cleanup share owned-row locks and exclude each other. Accepted outputs are never
cleanup candidates. Unknown finalization preserves all keys. Unknown remote
upload outcomes retain pending exact-key tombstones even after a successful
delete; a late losing PutObject is deleted by a later reconciliation. Such rows
record `FRAME_UPLOAD_OUTCOME_UNKNOWN`, `nextCleanupAt` and bounded exponential
backoff, capped at one day. No bucket scan is used. Confirmed remote upload
settlement is needed before cleanup becomes permanently completed.

Private GET and HEAD verify current exact-source authorization before storage
access, then verify object size/SHA metadata. GET streams JPEG; HEAD has no body.
Both support one byte range and controlled 416, private/no-store caching and
nosniff. Missing, incomplete or tampered accepted sets fail closed; an invalid
persisted READY set is represented as an integrity failure in the public view.

## Reproducible evidence

Use the already-pinned toolchain, with no install:

```sh
export PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH"
export COREPACK_HOME="$PWD/tmp/runtime/corepack"
pnpm --filter @content-factory/api test
pnpm --filter @content-factory/worker test
pnpm --filter @content-factory/api typecheck
pnpm --filter @content-factory/worker typecheck
pnpm --filter @content-factory/api lint
pnpm --filter @content-factory/worker lint
pnpm --filter @content-factory/api build
pnpm --filter @content-factory/worker build
TZ=Asia/Novosibirsk POSTGRES_DB=cf_acceptance_20260916 \
  pnpm --filter @content-factory/api exec vitest run \
  --config vitest.integration.config.ts \
  test/frame-evidence.persistence.integration.spec.ts
```

The persistence test refuses any database other than the explicitly selected
disposable database. Eleven independently exercised scenarios cover module-wide
idempotency, competing replicas, lease/deadline identity, no attempt on deferral,
legacy recovery exclusion, real concurrent current-row mutation, pre-read and
finalization gates, deadline/grace versus stopped-owner retry, exact result/key
integrity, historical source rights and a delayed losing upload cleanup.

`apps/worker/test/fixtures/frame-extractor-harness.ts` runs the actual extractor
inside the pinned image against synthetic CFR, VFR, nonzero-start and anamorphic
inputs (12 decoded JPEGs), plus controlled rejection of a tiny distorted image.
Owner evidence: `tmp/frame-implementation/adapter-evidence.json`; independent
feasibility evidence: `SPARSE-FRAME-RECIPE-PROBE.md`. The harness uses its own
`/tmp/content-factory-frame-adapter-*` area and does not replace runtime files.

Focused HTTP/OpenAPI tests cover required typed request bodies, generated path
types, binary/range/error schemas, both admission flags, private GET/HEAD
200/206/416, missing/tampered objects and rights denial before storage access.
Worker lifecycle tests cover pending-upload lease loss, settled local streams,
ambiguous versus accepted finalization, partial uploads, absolute timeout and
scratch deferral, pending/unknown claim crash boundaries and durable ownership
before directory creation. Final worker unit suite: 114 tests passed.

## Deployment and rollback boundary

One additive migration extends the job enum, preserves the existing job-shape
CHECK branches and adds owned tables/compound identity constraints. Historical
migrations are unchanged. The implementation owner applied it only to the
authorized disposable database; a fresh baseline deployment proof and working
runtime rollout belong to the orchestrator/DevOps acceptance gate.

Rollback disables new frame admission and retains durable tables, existing
metadata, accepted private bytes and cleanup tombstones. Drain or stop active
attempts with their fences/deadlines; do not delete pool rows, reset lease
identities or drop frame history to force recovery. Manual editing, assembly,
approval and export remain independent and require live acceptance alongside
the new frame path. No provider, transcript, external AI or dependency upgrade
is included.
