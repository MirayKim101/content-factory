# Sparse-frame clean migration proof

Date: 2026-09-16. Operator: `/root/restored_runtime`; root independently checked
saved command/evidence and the current migration checksum. Verdict: **PASS for
fresh disposable deployment**, not working-runtime rollout.

The label-verified `content-factory-restored-postgres-1` hosted a newly created
`cf_frame_migration_check_20260916`, required absent before creation. Repository
Prisma configuration with an explicit database override deployed all 16
migrations. Status reported up to date; a second deploy was a no-op.

Final migration: `20260916090000_sparse_frame_evidence`.
SHA-256: `6c04b77676c1420b6bcf979afe75cb985d68d98738d700be03764b1f68211736`.

The proof verified 16 finished/zero unfinished migrations, seven frame tables,
16 frame foreign keys, the exact-key constraint, the new pipeline enum value
and the extended legacy `PipelineJob_montage_type` constraint. The latter was
caught by integration testing and corrected only in the new additive migration;
historical migration files remain unchanged.

The disposable database was guarded-dropped and confirmed absent after success.
Neither the working `content_factory_restored` nor the separate integration
`cf_acceptance_20260916` was a migration/restore target in this proof.

Ignored evidence, restricted to mode 0600 under mode-0700 `tmp/recovery`:

- `frame-migration-proof-20260916.json`;
- `frame-migration-proof-20260916.log`;
- `frame-migration-proof-20260916.sql.txt`;
- reproducible `prove-frame-migration-20260916.sh` (mode 0700).

Two initial harness-only path/quoting issues were corrected with the exact
intermediate disposable databases removed before the final clean run. No
working database, service, storage policy or feature flag changed.
