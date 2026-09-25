# Stage 2B-6 local rollout evidence — 2026-09-25

## Scope

This rollout was limited to the isolated Content Factory restored runtime. It
did not use port 3000 and did not access any protected external directory or
service. The working database was `content_factory_restored` on
`127.0.0.1:15432`.

## Backup and restore proof

The exact PostgreSQL container was verified by Compose labels as
`content-factory-restored|postgres|running|healthy`. A custom-format backup was
created before migration:

- dump: `tmp/recovery/content-factory-restored-pre-stage2b6-rollout-20260925T163900Z.dump`;
- SHA-256: `691ee3391fa4719924bc2e3a42cebdca9544642915aba10c9baf3c30bbdaabd4`;
- size: `337977` bytes;
- restore list: 547 lines;
- local file modes: `0600` under ignored `tmp/recovery`.

The dump was restored into only the guarded disposable database
`cf_stage2b6_restore_check_20260925`. The restored state contained 27 completed
migrations, 5 projects and zero unvalidated constraints. The disposable
database was then dropped with `FORCE`; the working database was never a restore
target.

## Migration and runtime verification

`prisma migrate deploy` applied exactly:

1. `20260925221000_transcript_attempt_scoped_object_key`;
2. `20260925230000_transcript_attempt_updated_at_semantics`.

Post-rollout evidence:

- Prisma reports all 29 migrations applied and the schema up to date;
- `TranscriptEvidenceAttempt.updatedAt` is `NOT NULL` with no database default,
  matching Prisma `@updatedAt` semantics;
- `GET http://127.0.0.1:3001/api/v1/health` returns `{"status":"ok"}`;
- the UI route on `127.0.0.1:3100` returns HTTP 200;
- the current benchmark cut returns review contract v2, integrated review
  enabled, `MANUAL` workflow, `MANUAL` metadata and thumbnail components with
  no incomplete reasons, and `approvable=true`;
- no approval was created on the owner's behalf.

Windows Computer Use could not attach because its runtime rejected the WSL task
path before any UI action. Therefore HTTP/runtime evidence and the `238/238`
web suite do not replace the remaining human visual smoke and manual/assisted
operator benchmark.

## Rollback

Keep AI admission flags off or turn them off first. Do not remove additive
columns or historical rows. Restore is reserved for an explicit database-loss
decision; normal rollback is application/admission-first. The verified backup
above is retained locally and ignored by Git.
