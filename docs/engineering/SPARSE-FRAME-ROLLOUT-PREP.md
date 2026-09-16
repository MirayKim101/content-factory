# Sparse-frame rollout preparation — 2026-09-16

## Scope

This preparation is limited to the isolated restored Mac-baseline runtime. It
does not apply a migration, change a feature flag, rebuild a service, alter the
MinIO policy, or write to `content_factory_restored`.

The Stage 2B-2 contract is still a draft under independent architecture review.
Its rollout gate requires a verified restored-database backup before the
additive schema is admitted.

## Scoped backup

Before dumping, Docker labels were checked for the only database container used:
`content-factory-restored|postgres|running|healthy`. Inside that container,
`current_database()` returned `content_factory_restored`.

The resulting custom-format dump and its verification artifacts are ignored
local files with mode `0600`; their parent `tmp/recovery` is mode `0700`.

| Item         | Value                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Dump         | `tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump` |
| SHA-256      | `9baf738eed774ed4a126f06c3c8ddd3eb57f5b558f7d77fc39a7b05645cf61d0`         |
| Size         | `222403` bytes                                                             |
| SHA sidecar  | same filename with `.sha256`                                               |
| Restore list | same filename with `.list`, `366` lines / `355` TOC entries                |

The dump was produced by PostgreSQL 18.6 `pg_dump -Fc` through the
label-verified container. Its bytes were streamed back into that same container
only for the initial `pg_restore --list` TOC check; that initial check created
no restore target and wrote no database row. The list confirms custom format,
the expected source database, and both `CreatorProfile` and `PipelineJob`
schema entries.

Before an additive migration, re-check the checksum and archive format:

```sh
sha256sum -c tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump.sha256
docker exec -i content-factory-restored-postgres-1 sh -ceu \
  'umask 077; cat > /tmp/content-factory-restore-validation.dump; pg_restore --list /tmp/content-factory-restore-validation.dump' \
  < tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump
```

Any restore drill must use a separately named disposable database. Do not restore
over `content_factory_restored`; forward-compatible migration rollback remains
admission-off rather than destructive rollback.

## Restore verification

The checksum was verified again immediately before an actual restore to the
explicit disposable database `cf_stage2b2_restore_check_20260916`. The command
used `pg_restore --exit-on-error --no-owner --no-privileges` as the current
restored-runtime PostgreSQL role. It completed with an empty restore log. The
working `content_factory_restored` database was never selected as a restore
target.

The restored database had all 15 completed Prisma migrations, no unfinished
migration row, and no unvalidated `public` constraint. Its key row counts,
captured from the restored archive rather than a later live query, were:

| Entity                             | Restored count |
| ---------------------------------- | -------------: |
| CreatorProfile                     |              3 |
| CreatorProfileRevision             |              6 |
| CreatorReferenceAsset              |              4 |
| SourceEditorialContext / revisions |          1 / 2 |
| CutEditorialPrompt                 |              1 |
| PipelineJob / JobAttempt           |        13 / 15 |
| MediaArtifact                      |             12 |
| EditorialPackage                   |              1 |

After these checks, the database was dropped only after an exact-name guard and
a second check that it existed. A final catalog query confirmed that
`cf_stage2b2_restore_check_20260916` no longer exists. The ignored restore log
and restored-counts JSON remain mode `0600` with the dump evidence.

## Independent reproduction

An independent reviewer repeated the verification against the same SHA-256 and
mode-`0600` dump. The reviewer created the separate exact-name database
`cf_stage2b2_backup_root_20260916`, ran
`pg_restore --exit-on-error --no-owner --no-privileges` successfully, and
confirmed from that database: 15 migrations, 3 creator profiles, 13 pipeline
jobs, 12 media artifacts, and zero unvalidated constraints. The reviewer then
dropped only that exact disposable database behind an existence/name guard.

Result: **CLEAN** for the bounded backup and restore-preparation scope. This
does not approve the Stage 2B-2 contract, migration, feature flags, MinIO
policy extension, or runtime rollout.

## Original runtime readiness observations (before contract freeze)

The current media runtime is
`content-factory-media-worker:0.0.0-stage1`, label-verified as
`content-factory-restored|media-worker|running|healthy`. It already owns
FFmpeg/FFprobe media work and is the runtime named by the Stage 2B-2 draft for
the future sparse-frame extractor. No image rebuild or worker restart occurred
for this preparation.

The draft requires a new narrow private frame-object namespace, distinct from
existing `sources/*`, `editorial/*`, and
`ai-content/creator-profiles/*/references/*`. It deliberately does not freeze
the exact frame object-key prefix. Therefore no MinIO permission is added here:
the approved Stage 2B-2 contract/implementation must first specify its exact
owned prefix and only then add the matching minimal Get/Put/Delete/multipart
actions to the restored runtime policy. Bucket-wide or generic `ai-content/*`
permission remains prohibited.

## Fresh backup before frame rollout — 04:25 UTC

After contract freeze and the disposable migration proof, DevOps took another
non-overwriting PostgreSQL consistent snapshot at `2026-09-16T04:25:38Z`.
API and worker were not stopped. This is a database snapshot; it is not a claim
that all application writers were quiesced.

Dump: `tmp/recovery/content-factory-restored-pre-frame-rollout-20260916T042538Z.dump`
(224046 bytes, mode 0600). SHA-256, independently rechecked by root:
`ee75746798fb66614c204f8730f6da9d19346dea182f3a707ae1641d3d0724b7`.

Full `pg_restore --exit-on-error --no-owner --no-privileges` into the newly
created `cf_frame_backup_restore_20260916` passed. It contained the expected
15 baseline migrations, no frame migration/table/enum, four creator profiles,
13 jobs, 15 attempts, 12 media artifacts and zero unvalidated constraints.
The exact disposable restore database was guarded-dropped and confirmed absent.
Sanitized detailed evidence is the adjacent `.restore-evidence.json`; the
working database was never a restore target.

The final additive migration separately passed clean deployment from baseline:
`SPARSE-FRAME-MIGRATION-PROOF.md`. The narrow frame namespace is now frozen in
`tasks/stage2b-sparse-frame-evidence.md` and reviewed in
`SPARSE-FRAME-STORAGE-POLICY.md`. This backup operation itself applied no
migration, policy, feature flag or service change.
