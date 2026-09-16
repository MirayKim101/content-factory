# Sparse-frame persistence checkpoint review

Date: 2026-09-16. Independent reviewer: `/root/rollout_review`.
Verdict: **CLEAN for the schema and persistence checkpoint** after actual-diff
review and independent PostgreSQL reproduction. Worker process orchestration,
fresh-baseline migration deployment, frontend and runtime acceptance remain
separate gates.

The reviewer independently reproduced
`apps/api/test/frame-evidence.persistence.integration.spec.ts`: **9/9 passed**
in a disposable PostgreSQL database. Prisma validation passed; generated schema
delta matched the new migration plus intentional CHECK constraints. A separate
short-cut regression confirmed that a measured PTS beyond the captured cut is
rejected. The new frame connection pool's UTC parser is scoped to that pool and
does not change global PostgreSQL type parsing.

Resolved findings in the inspected code:

- composite foreign keys bind slot/attempt lease and deadline identity;
- composite lineage constraints bind profile, context, prompt and exact cut;
- content reads validate the exact owned output key and accepted attempt;
- incomplete or tampered READY results fail closed;
- measurements are bounded by the immutable cut duration, not the global
  ten-minute admission ceiling;
- recovery's terminal deadline path records its completion time;
- upload-start/settlement and cleanup-backoff columns are present in both schema
  and migration.

The reproduced suite covers shared idempotency, independent worker slot
exclusion, lease fencing, pre-read currentness, exact three-frame acceptance,
historical metadata versus current source rights, partial output rejection,
unknown-upload cleanup tombstones and incompatible lineage constraints. Legacy
lease recovery cannot bypass the frame slot/deadline rules.

The contract's unknown-outcome clarification was separately approved: reclaiming
capacity after deadline/grace does not prove remote upload settlement. Uncertain
losing outputs retain pending exact-key cleanup with scheduled backoff, including
after an earlier delete; accepted output keys remain protected.

This checkpoint does not authorize a working-database migration by itself. The
final migration must still deploy from its baseline in a fresh disposable DB,
and the complete worker application must pass its independent checks before
controlled restored-runtime rollout.
