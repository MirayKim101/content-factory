# Transcript worker recovery acceptance

Date: 2026-09-25

## Scope

This checkpoint closes the remaining Stage 2B-3 worker recovery gate against a
disposable PostgreSQL database and the private Content Factory object storage.
It does not enable an external transcription provider or change the manual
editorial path.

The opt-in integration creates a guarded database named
`content_factory_transcript_<uuid>`, applies all current migrations, seeds exact
source/cut/profile/context/prompt lineage and drops the database with `FORCE` in
`afterAll`. New transcript objects use the attempt-owned bounded key
`ai-content/transcripts/<intent UUID>/attempts/<attempt UUID>/transcript.json`;
the database constraint continues to accept existing canonical keys. Rejected
attempt uploads are deleted by the worker and accepted test objects are deleted
during cleanup. Port 3000 is not used.

Each new attempt persists its exact object key and cleanup tombstone before
upload. `uploadStartedAt` and `uploadSettledAt` distinguish a known upload from
an uncertain PUT. Cleanup locks and rechecks the attempt, intent and exact
artifact: an active current lease is never deleted, an accepted artifact is
marked `NOT_REQUIRED`, and a losing object remains `PENDING` with backoff until
deletion is safe. The AI worker runs this reconciliation at startup, before
deliveries and every five seconds.

PUT uses a 25-second AbortSignal deadline, shorter than the 30-second lease.
Cleanup uses two short database transactions around object deletion: the first
locks and reserves the exact losing attempt, DELETE runs without database
locks, and the second rereads the exact artifact key before a fenced CAS marks
completion. An unsettled PUT keeps a recurring `PENDING` tombstone even after a
successful DELETE, so a late write is deleted again instead of becoming an
orphan.

## Findings fixed by the real run

The first real-database run exposed three conditions that mocked SQL could not
detect:

1. PostgreSQL `timestamp(3)` leases were parsed as worker-local time. Outside
   UTC, a fresh lease could look expired and leave an intent in `PROCESSING`.
   The transcript pool now fixes the session timezone to UTC and uses the same
   explicit timestamp parser as the accepted frame worker.
2. Finalization and failure recording sent two parameterized SQL commands in a
   single prepared statement, which PostgreSQL rejects. Each state transition
   is now a separate statement inside the existing transaction.
3. The retry-state `CASE` mixed text literals with the PostgreSQL enum. Both
   branches now use explicit `TranscriptIntentState` casts.
4. Lease decisions used the worker process clock and finalization checked only
   the longer work deadline. Claim and finalization now use PostgreSQL `now()`,
   require both the 30-second lease and 120-second deadline, and stop if the
   fenced expired-attempt update loses its race.
5. A fixed object key let a late attempt overwrite or delete the accepted bytes
   of a newer attempt. New uploads use attempt-owned keys; a rejected lease or
   stale immutable context removes only that attempt's object.
6. An acknowledged `COMMIT` is not assumed. If commit acknowledgement is lost,
   the worker authoritatively rereads the exact intent, attempt and artifact.
   A committed READY aggregate preserves its object; an unavailable or unknown
   outcome remains `PENDING` and is not converted to a false delivery failure.

An expired attempt is also closed with
`TRANSCRIPT_LEASE_EXPIRED` before the restarted worker creates the next attempt.
Failure recording checks that both fenced updates affected exactly one row and
always releases its database connection.

## Reproduction

All commands use the project-pinned Node 24 runtime:

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  TRANSCRIPT_WORKER_ISOLATED_TESTS=1 \
  pnpm --filter @content-factory/worker exec vitest run \
  --config vitest.integration.config.ts \
  test/transcript-worker-isolated.integration.spec.ts
```

Result: `1 file, 4 tests passed`.

The four integration cases prove:

- one normal delivery creates one READY attempt, one authoritative database
  artifact and checksum-matching private JSON bytes;
- duplicate delivery through a new worker instance creates no second attempt or
  artifact;
- a seeded expired lease is recorded as failed, a restarted worker creates
  attempt 2 and reaches READY, and later duplicate delivery remains a no-op;
- stale source authorization converges to controlled `FAILED_FINAL`, persists
  no artifact row and removes the attempt-owned object from private storage;
- inaccessible object storage records attempt 1, returns the intent to QUEUED,
  then records attempt 2 and converges to controlled `FAILED_FINAL` without an
  artifact or stuck `PROCESSING` row.

Focused unit evidence:

```sh
pnpm --filter @content-factory/worker exec vitest run \
  test/pg-transcript-worker.spec.ts
```

Result: `1 file, 14 tests passed`. The cases include database-clock fencing,
lost expiry races, active-lease cleanup exclusion, ambiguous-COMMIT winner
preservation and unavailable reread, two-phase cleanup ordering, durable DELETE
retry, bounded PUT abort, retry exhaustion and recurring uncertain-PUT
tombstones.

Full worker suite:

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  pnpm --filter @content-factory/worker test
```

Result: `15 files, 143 tests passed`.

Prisma schema validation plus worker typecheck, lint and build pass. Architect
review is APPROVED and independent real-diff review completed CLEAN.

## Rollback

Revert the transcript worker, additive recovery migration and tests together.
The migration widens the private-key check, adds nullable/defaulted attempt
recovery fields and does not rewrite existing objects. Existing transcript rows
and private artifacts remain readable; rollback must not start
an older worker while a transcript attempt is actively leased or while a new
attempt-scoped artifact row exists. New nullable attempt columns default old
rows to `NOT_REQUIRED`; no existing row is scheduled for deletion.
