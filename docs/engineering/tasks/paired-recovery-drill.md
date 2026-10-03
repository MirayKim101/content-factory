# Paired metadata and object recovery — diagnostic drill

Date: 2026-10-03. This is a small, non-versioned, disposable-fixture drill,
not a production backup service, production recovery SLO or rollout approval.

## Acceptance boundary

Restore must use one matching PostgreSQL dump and object snapshot. All database
rows, ready-artifact references, object bytes, checksums and metadata must agree.
A missing, corrupt, versioned or mismatched snapshot must fail before object
writes. Existing object namespaces must never be overwritten.

`scripts/diagnostic-pair-recovery.mjs` accepts only the fixed diagnostic database,
bucket, fake credentials and project names. It requires UID 1000, manual rights
authorization and every external/AI/publishing switch off. It is deliberately
limited to 100 non-versioned MP4 objects, 1 MiB per object, a 16 MiB dump and
10,000 rows per table. Versioned storage needs a separately designed recovery
mapping; this helper refuses it rather than silently rewriting lineage.

## Actual recovery unit

The source was only `cf-api-proof-20261003`, never the working restored runtime.
Its API and media writer were stopped after all jobs reached terminal states.
The dump and object capture were taken while both writers remained stopped;
they were restarted after capture. The helper compares database fingerprints
before and after object capture. A database fingerprint alone does not replace
the operator's writer-quiescence requirement.

The snapshot records schema/source checkpoint
`3ac670c3923ab5570cc8ef404c32f230832ebe70`. Actual source API image was the
earlier `d6d3d30` diagnostic build and media image the `8ae525e37920` build.
This drill does not claim a combined v3/security candidate was running.

- Private snapshot: `tmp/paired-recovery-YoJzV6`.
- Dump: 397,912 bytes, SHA-256
  `299b0053717559f27554be1a2d34fedf4ae31a64a49d1304d8e0de413d0150a2`.
- All 74 public tables: fingerprint
  `6e88dbe07b4c8f7044b6e058c490948c62c56199ef7c78e9fe7e4a325c3061a6`.
- 45 completed migrations, zero unvalidated constraints, no active media jobs.
- 12 objects, 128,600 bytes total; 12 matching ready artifacts.
- Final evidence: `tmp/paired-recovery-evidence-zLpFtT/restore-evidence.json`.
- Final verification timestamp: `2026-10-03T14:36:39.282Z`.

Dump, manifest and evidence are local private artifacts, not committed data.
Object filenames are hashes of keys, not paths derived from object keys.
Files are created exclusively, with restricted permissions; symlinked inputs
are rejected. The final restore mounts the entire snapshot read-only and puts
its result certificate in a separate evidence directory.

## Actual positive and negative scenarios

1. A fresh `cf-pair-restore-20261003` project provided separate PostgreSQL,
   Redis and MinIO on one internal network, with no host ports. Label checks
   established ownership and PostgreSQL had zero public tables before restore.
2. PostgreSQL restored the custom dump with `--single-transaction`,
   `--exit-on-error`, `--no-owner` and `--no-privileges`.
3. Before any S3 PUT, the helper validated the whole snapshot and all restored
   database rows/references, and required the destination bucket to be empty.
4. After restoring all 12 objects, GET verified bytes, sizes, checksums,
   ETags, content types and metadata. All 74 database fingerprints still matched.
5. The first restored API served all three ready cut results with matching
   checksums and correct HTTP Range 206. This first small-fixture restore took
   2,069 ms from restore command to final verification; it is not a capacity SLO.
6. Only that disposable target was removed and recreated for the negative
   drill; the original snapshot and source project were retained.
7. A separate snapshot copy omitted one object. Restore exited non-zero with
   `ENOENT` before any PUT. The subsequent valid restore again observed an
   empty destination, proving zero writes from the failed preflight.
8. Final valid restore used a read-only snapshot and produced a separate
   exclusive certificate with `emptyTargetBeforeRestore=true`, `passed=true`
   and `promotionApproved=false`.

The helper does not promise atomic multi-object writes after a mid-transfer
network failure. Such a failure leaves only the disposable target to discard
and recreate; it must not be retried over an existing bucket. Only complete
post-restore verification produces a success certificate.

## Verification and rollback

The three policy tests cover matching manifests, incomplete/corrupt dumps and
objects, unsupported versions, traversal, duplicates and symlinked inputs:

```sh
node --test scripts/diagnostic-pair-recovery.test.mjs
```

Runtime verification uses the helper's `verify` phase, the same fixed fake
namespace, a read-only `/recovery` mount and no writable snapshot mount. It
performs database SELECTs and S3 LIST/GET only. It must run only on the
label-verified `cf-pair-restore-20261003` internal network, never against
`content-factory-restored` or a deployment.

Rollback is disposal of only the label-verified test target after retaining
the recovery unit and evidence. Do not remove source data or working volumes.
The private retained snapshot can recreate the disposable target. There is no
production deployment or schema change to roll back in this slice.

## Still required before production

- Version-aware source/derived/reference/thumbnail object recovery and complete
  lineage coverage beyond these diagnostic MP4 namespaces.
- Quiescence/fencing across every enabled writer, not only the media fixture.
- Encrypted off-host backups, retention, credential separation and scheduled
  restore drills with realistic media size and an agreed RPO/RTO.
- Failure-safe operational recovery tooling and documented operator ownership.
- Independent review, clean source/artifact release gates and all ADR-011
  deployment prerequisites. This drill satisfies none by implication.
