# Local manual-cut migration reconciliation — 2026-09-09

## Scope and decision

The unpublished, uncommitted migration
`20260909190000_stage1_manual_horizontal_cut` was applied only to the local
Content Factory database at 13:00 UTC. Review identified missing explicit
transaction boundaries. The independent reviewer approved adding `BEGIN` and
`COMMIT`, with a narrowly guarded checksum reconciliation after backup and
verification. This is a documented local exception, not a procedure for changing
published migrations.

The implementer added the wrapper before the orchestrator captured original
bytes. An initial reconstruction retained an extra newline and failed the stored
checksum guard. The orchestrator halted without modifying database metadata.
Both orchestrator and independent reviewer subsequently reconstructed the exact
original bytes and confirmed that only the transaction wrapper had changed.

## Evidence

- API stopped; no worker running; implementer paused retained database writers.
- Fresh custom-format backup, mode `0600`, verified with `pg_restore --list`:
  `tmp/recovery/before-cut-migration-repair-20260909T131723Z.dump`.
- Original SQL: 4675 bytes, SHA-256
  `2e9432e1d0762d09c28a9b02d833aeb0b73d3cbfb071aee4e5cccd6974e8a290`.
- Wrapped SQL: 4692 bytes, SHA-256
  `ddc7f1fee684904fb5c87c552394b4a497d49d6476f01253de6592d206a696c1`.
- Exact transformation: insert `BEGIN;\n\n` after the two-line header and append
  `\nCOMMIT;\n`. No existing SQL bytes changed. Both copies are preserved under
  `tmp/recovery/cut-migration-{original,wrapped}.sql`, mode `0600`.
- Implementer verified all four migrations on an isolated fresh database.
  Injecting a late failure followed by explicit `ROLLBACK` left no cut tables,
  cut enum types, or `HORIZONTAL_CUT` artifact role.

## Guarded operation and postchecks

The orchestrator used one PostgreSQL transaction and an exclusive lock on
`_prisma_migrations`. It required exactly one migration row, the original
checksum, the captured row ID, a completed/non-rolled-back migration with one
applied step and null logs. It also required six rows in each existing business
table and zero jobs/attempts. The update changed only `checksum`; a row-count
assertion and JSON comparison of all other metadata ran before commit.

All guards passed. Projects, sources, authorizations and artifacts remain
6/6/6/6; jobs and attempts remain 0/0. Full schema-only dumps before and after
are identical after removing randomized PostgreSQL dump restriction tokens;
normalized SHA-256:
`27b3e102f3edce503712cabbf004b913db35ec45ecbe601c09b8a2669991b40d`.

`pnpm --filter @content-factory/api exec prisma migrate status` reported all four
migrations up to date. `pnpm --filter @content-factory/api db:migrate` reported
no pending migrations. Retained writer pause was released after these checks.
Local operation output and schema dumps are under `tmp/recovery/cut-repair-*`.

## Recovery considerations

No business data or schema was changed by the checksum reconciliation. A failed
guard would have rolled back the metadata transaction. Keep the verified backup
until the manual-cut delivery is accepted; any restore requires quiesced writers
and a separately reviewed plan. Do not automatically restore over newer data or
run an older API against the newer nullable-rights schema.
