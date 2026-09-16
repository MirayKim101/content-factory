# Restored worker verification — 2026-09-16

## Scope

Re-run the recovered API/worker unit tests and targeted PostgreSQL integration
scenarios during isolated WSL rollout. The merge-only test waiver from September
9 does not count as runtime acceptance.

The integration database is `cf_acceptance_20260916` on the new
`content-factory-restored-postgres-1` container, separate from both the restored
application database and the legacy WSL database. Existing migrations were
applied to this empty disposable database. No legacy schema or data was changed.

## Findings and corrections

The lease recovery race test assumed attempt 2 could be claimed immediately
following reconciliation. The repository deliberately schedules a five-second
backoff, so the actual result was `RETRY_WAIT`, attempt count 1. The test now
first verifies an early delivery does not claim the job, then advances only the
disposable fixture's `nextAttemptAt` into the past. Its original assertions
still verify attempt 2 wins and stale attempt 1 cannot overwrite or delete it.
Production retry timing is unchanged.

Two regression tests cover the cut-finalization safeguard ported during merge:

- If commit succeeds but its response is lost, an authoritative accepted-result
  reread preserves the object and does not mark the job failed.
- If that reread also fails, the uploaded object and durable cleanup intent are
  retained; a typed retryable `CUT_FINALIZE_OUTCOME_UNKNOWN` is reported.

The existing rejected-finalization test still verifies cleanup when the result
was not accepted. No production code changed in this verification slice.

## Commands and results

Use the pinned local Node/pnpm toolchain documented in the runtime guide.

```sh
pnpm --dir apps/api test
pnpm --dir apps/worker test
POSTGRES_DB=cf_acceptance_20260916 MEDIA_QUEUE_DISABLED=1 \
  pnpm --dir apps/api test:integration test/creator-context.api.integration.spec.ts
POSTGRES_DB=cf_acceptance_20260916 MEDIA_QUEUE_DISABLED=1 \
  pnpm --dir apps/worker test:integration test/lease-recovery.integration.spec.ts
pnpm --dir apps/worker typecheck
pnpm --dir apps/worker lint
```

Results: API 123 unit tests; worker 84 unit tests; creator-context PostgreSQL
integration 2 tests; lease recovery PostgreSQL integration 5 tests. Local logs
are in `tmp/recovery/restored-{api-unit,worker-unit,creator-integration,lease-integration}.log`.
Independent review: CLEAN. The reviewer reproduced worker unit 84/84, lease
integration 5/5, typecheck and lint against the real diff and disposable database.
An additional broad worker integration invocation encountered a missing host
`unzip` executable in ZIP64 verification; no full worker integration pass is
claimed. The targeted suites above passed.

These checks are targeted evidence, not a claim that every historical
integration, FFmpeg, browser, or failure-recovery scenario has been rerun.
