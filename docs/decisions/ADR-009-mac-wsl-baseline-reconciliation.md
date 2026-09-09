# ADR-009: Reconcile the Mac product baseline with the WSL recovery

- Status: accepted for the 2026-09-09 recovery merge
- Decision owner: Content Factory architect / orchestrator
- Owner authorization: merge the newer Mac project into the Git repository;
  full test execution may be skipped for this recovery merge

## Problem and evidence

The repositories share commit `1dde0b4`, then diverge:

- the Mac line reaches `b13ea84` through 36 commits and contains the accepted
  Stage 1, full manual Stage 2, and accepted Stage 2B-1 backend foundation;
- the WSL line reaches `6e5097d` through 10 recovery commits and independently
  reconstructs upload, authorization, cutting, and Linux worker runtime;
- the transferred Mac working tree contains 11 real tracked changes and eight
  new source/documentation files beyond `b13ea84`. They are preserved as the
  immutable import commit `33f57c8b5f620b789dff011fab46a1d6b3be0263`.

The two implementations cannot be combined field by field. They define
different Prisma migration histories and incompatible meanings for source
authorization, artifact roles, pipeline job types and states, attempts,
idempotency, progress, and result ownership. A normal textual merge could
compile while silently combining two state machines or could leave both
divergent migrations deployable.

The Mac implementation has the later, broader evidence: its handoff records the
manual editorial draft, montage assets and recipes, horizontal assembly,
approval, ZIP export, live FFmpeg artifacts, and independent reviews. Its
Stage 2 behavior directly answers the owner's report that advertising and
thumbnail work had already been implemented.

## Decision

Use the complete Mac snapshot `33f57c8` as the product, schema, API contract,
generated client, media-worker, and user-interface baseline.

Create one integration merge whose first parent preserves the WSL recovery
head `6e5097d` and whose second parent is the imported Mac snapshot. Parent
ordering reflects where the recovery worktree was created; it does not select
the product baseline. Construct the resulting tree explicitly from the Mac
snapshot instead of accepting automatic content merges. Preserve the current
strict, case-insensitive prohibition on all interaction with directories named
`Seanova` or `DockerServer` in `AGENTS.md`.

The imported working changes are retained as Stage 2B-1 frontend work in
progress. Their presence does not change the accepted status of the backend or
prove frontend acceptance.

The WSL line remains available through its Git parent and recovery reference.
Its reports and database evidence are historical evidence for an alternate
reconstruction. They must not overwrite the current Mac handoff, product
roadmap, accepted ADRs, or acceptance status.

### Explicit conflict markers

- Mac ADR-003 and ADR-004 remain authoritative for source-version
  authorization and the guarded local-development exception.
- The WSL authorization reconstruction, including its different
  `sourceSha256`, basis values, request DTO, and migration
  `20260909120000_exact_source_authorization`, is **SUPERSEDED ALTERNATE
  RECOVERY — DO NOT APPLY TO THE MAC MIGRATION LINE**.
- The WSL manual-cut package and migration
  `20260909190000_stage1_manual_horizontal_cut` are **SUPERSEDED ALTERNATE
  RECOVERY — DO NOT DEPLOY OR CHERRY-PICK INTO THE MAC BASELINE**.
- The WSL generated-Prisma packaging boundary, generated-client workflow, and
  worker container files were built around that alternate package graph. They
  are not copied blindly. The imported Mac worker, Dockerfile, Compose service,
  contracts package, and pinned FFmpeg runtime stay together as one coherent
  runtime.

## Keep-current option

Keeping `6e5097d` as the active baseline would preserve a WSL-tested Stage 1,
but it would discard or require reimplementation of the accepted manual Stage
2 and Stage 2B foundation. It also contradicts the newly recovered source and
the owner's recollection. This option is rejected.

## Alternatives considered

### Regular merge and conflict resolution

Rejected. Git can detect overlapping text but cannot resolve incompatible job
state semantics or migration ledgers. Automatically merged files would not be
reliable evidence of a valid domain model.

### Cherry-pick all Mac commits onto WSL

Rejected. The early Stage 1 migrations and application modules would collide
with their separately reconstructed WSL equivalents before the later Stage 2
commits could be applied.

### Squash the Mac directory over WSL

Rejected. It would produce the right-looking tree while losing the accepted
Mac history and obscuring the relationship to both recovery lines.

## Data migration and rollout

This Git reconciliation does not authorize a live database rollout.

The current WSL PostgreSQL database and object-storage data were created by the
alternate WSL migration line. Do not run Mac migrations or start a Mac API or
worker against them. Preserve a verified database dump and the existing media
objects, then keep that environment isolated and stopped.

Bring up the Mac baseline only with a new empty Content Factory database and a
separate Content Factory object-storage namespace, or restore a matching Mac
database and objects if an independently verified backup is later found. If
WSL-created projects must be carried forward, specify and review a separate ETL
migration that maps exact source, authorization, job, attempt, artifact, and
checksum lineage. In-place edits to `_prisma_migrations` are not part of this
decision.

## Security and data impact

The merge preserves the Mac fail-closed authorization gates, immutable
artifact lineage, checksums, versioned recipes, private thumbnail/reference
assets, and PostgreSQL-owned job state. It must not relax ADR-003, ADR-004, or
ADR-008 by copying individual WSL handlers or schema fields.

No project records or media objects are deleted by the Git merge. Running the
wrong binary against the alternate database is the primary data risk, so
database and storage isolation is a release gate.

## Operating cost

The merge adds no provider or hosting cost. Temporary cost is limited to an
additional local database/storage namespace, backup space, dependency install,
and rebuilding the media-worker image. Paid AI providers remain disabled.

## Verification and owner's test waiver

The owner explicitly allowed the full test stage to be skipped to prioritize a
correct recovered repository. Therefore this merge may be committed and pushed
without rerunning every historical unit, integration, browser, performance, or
failure-recovery test. The final report must state exactly which checks were
not run and must not describe the imported frontend WIP or runtime as newly
accepted.

Before calling the repository structurally merged, verify at minimum:

1. the integration commit contains both `33f57c8` and `6e5097d` as ancestors;
2. the resulting application tree and migration sequence match the Mac
   baseline, with no WSL `20260909` application migrations or
   `packages/manual-cut` alternate implementation;
3. all 19 real Mac working-tree files are present, while Windows-only file-mode
   noise, caches, dependencies, secrets, and temporary files are absent;
4. the strict protected-directory rule is present;
5. Prisma schema validation/generation, TypeScript build/typecheck, and OpenAPI
   drift checks are attempted when the recovered toolchain permits; any skipped
   or failed command is reported rather than hidden;
6. no existing WSL database, object store, worker, or migration ledger is
   modified during the Git merge.

## Rollback

Keep immutable refs for the Mac import, the WSL recovery head, and the
pre-integration remote branch. Rollback is a branch/ref switch to the required
line; it does not rewrite either history. Because this decision forbids a live
data migration, repository rollback requires no database reversal. A future
data import must define its own transactional rollback and object cleanup.

## Measurable success criteria

- GitHub contains one reviewable integration branch with both histories and the
  explicit Mac product tree.
- Stage 1 and manual Stage 2 code, contracts, migrations, worker, and UI come
  from one internally consistent migration line.
- Stage 2B-1 backend remains recorded as accepted and the recovered frontend is
  clearly marked work in progress pending verification.
- Existing WSL data remains unchanged and recoverable.
- The handoff gives the owner a truthful remaining-MVP report: Stage 2 is
  implemented; Stage 2B after its foundation and all of Stage 3 remain.
