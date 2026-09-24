# Stage 2B-6 integrated review — disposable E2E evidence

Date: 2026-09-24

## Scope and isolation

This evidence uses only the restored ContentFactory local PostgreSQL endpoint
(`127.0.0.1:15432`) and private MinIO endpoint (`127.0.0.1:19000`). It does
not start an HTTP server and does not use port 3000.

`apps/worker/test/assembly-repository-isolated.integration.spec.ts` creates a
database named `content_factory_worker_assembly_<uuid>`, applies all current
migrations, and drops that database in `afterAll`. The real-storage case writes
only these known keys, then deletes each in `finally`:

```text
sources/<project UUID>/stage2b6-e2e-<UUID>/render.mp4
sources/<project UUID>/stage2b6-e2e-<UUID>/thumbnail.png
sources/<project UUID>/editorial-exports/<job UUID>/attempt-1-<lease hash>.zip
```

The separate assisted-apply run creates the explicitly disposable
`cf_research_acceptance_20260924` database. The setup checks that it is absent
before creation; cleanup completed with `DROPPED_DISPOSABLE_DB`.

## Commands and results

All commands used the project-pinned Node runtime:

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  pnpm --filter @content-factory/worker typecheck
```

Result: PASS.

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  ASSEMBLY_REPOSITORY_ISOLATED_TESTS=1 STAGE2B6_REAL_STORAGE_E2E=1 \
  pnpm --filter @content-factory/worker exec vitest run \
  --config vitest.integration.config.ts \
  test/assembly-repository-isolated.integration.spec.ts
```

Result: `1 passed`, `14 passed`, duration `19.74s`.

The new opt-in case uses a v2 approval snapshot, uploads exact render and
thumbnail bytes to real private object storage, lets the worker claim and
finalize its export, then reads the archive back through the authenticated
adapter. It verifies all of the following:

- the SHA-256 of the downloaded archive matches the persisted result;
- the ZIP has exactly five ordered entries: `video.mp4`, `thumbnail.png`,
  `metadata.txt`, `metadata.json`, `manifest.json`;
- manifest entry sizes and checksums match all four payload entries;
- manifest contract is `editorial-export-manifest-v2` and its snapshot mode is
  `MANUAL`;
- archive payload has no `objectKey`, `private/`, `prompt`, or `credentials`
  marker;
- after `EditorialPackage.currentRevision` changes, a new export admission for
  the prior approval throws `EditorialExportApprovalStaleError`; result and
  export-job artifact counts remain one.

The same opt-in harness also has a focused assisted/MIXED case:

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  ASSEMBLY_REPOSITORY_ISOLATED_TESTS=1 STAGE2B6_REAL_STORAGE_E2E=1 \
  pnpm --filter @content-factory/worker exec vitest run \
  --config vitest.integration.config.ts \
  test/assembly-repository-isolated.integration.spec.ts -t 'creates a MIXED'
```

Result: `1 passed`, `13 skipped` by the focused name filter, duration `2.76s`.
It creates an exact cited research intent/set/citation and no-likeness image
intent/candidate in the UUID database, uses the production
`PrismaEditorialApprovalRepository` with integrated review enabled to create
the v2 approval, and verifies `MIXED` workflow mode, two component snapshots,
zero-cost local economics, citation identity, and image-candidate identity.
The worker then creates and reads a real private MinIO ZIP. Its manifest is
checked for the citation ID, image-candidate ID, and `MIXED` mode, while
rejecting the private citation excerpt, object keys, prompts, and credentials.
After the editorial revision changes, a fresh export admission throws
`EditorialExportApprovalStaleError` and only one artifact remains for that
export job.

The local assisted inputs were separately exercised against a disposable
database and real MinIO for the image candidate:

```sh
PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
  POSTGRES_DB=cf_research_acceptance_20260924 IMAGE_STORAGE_SMOKE=1 \
  pnpm --filter @content-factory/api exec vitest run \
  --config vitest.integration.config.ts \
  test/research-metadata.persistence.integration.spec.ts \
  test/image-suggestion.persistence.integration.spec.ts
```

Result: `2 passed`, duration `3.63s`. These tests prove local cited-research
exact apply and local no-likeness image exact apply, including reload,
duplicate delivery, stale-context rejection, `AI_ASSISTED` provenance, and
zero direct local cost. The image candidate was stored through the real MinIO
adapter and its UUID key was deleted by the test's `afterAll` cleanup.

## Scripted benchmark record

This is a scripted proxy, not a human operator study and not a savings claim.
The automated cases do not measure real foreground attention, so missing human
measurements are shown as unavailable rather than converted to zero.

| Run                          | Exact mode exercised                                              | Preparation / final review attention                               | Wall clock                          | Direct AI cost           | Outcome                                                  |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- | ------------------------ | -------------------------------------------------------- |
| Manual v2 export fixture     | `MANUAL` / `MANUAL`                                               | `1000ms / 2000ms` fixture snapshot; not human-measured             | Included in the 19.74s worker suite | `0 microusd`             | READY ZIP, five-entry and checksum checks passed         |
| Local assisted apply fixture | research metadata and no-likeness thumbnail `AI_ASSISTED` applies | unavailable: these pre-approval tests do not simulate human review | Included in the 3.63s API suite     | `0 microusd` local basis | exact apply, replay and stale checks passed              |
| Mixed v2 export fixture      | metadata `MIXED`, thumbnail `AI_ASSISTED`                         | `1100ms / 2200ms` fixture snapshot; not human-measured             | 2.76s focused test                  | `0 microusd` local basis | approval, private ZIP, and stale admission checks passed |

The rows are not comparable operator-time evidence because the assisted path
has not yet been performed by a person through an approved v2 review. No claim
about time or cost reduction is supported by this document.
