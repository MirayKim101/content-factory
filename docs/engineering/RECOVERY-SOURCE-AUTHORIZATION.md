# Recovery task: exact-version source authorization

- Status: accepted after independent verification
- Architecture: ADR-003 approved
- Implementation: completed on WSL, 2026-09-09
- Independent review: CLEAN, 2026-09-09; see `RECOVERY-SOURCE-AUTHORIZATION-REVIEW.md`

## Пользовательская цель

После загрузки владелец видит сохранённый источник как `NOT_REVIEWED`, отдельно
подтверждает права именно для показанных версии и checksum и только затем
получает доступ к операциям над media. Старый upload checkbox не даёт допуска.

## Scope

One backend-led vertical slice may change the Projects domain/application,
Prisma schema and one additive migration, controller/DTO/OpenAPI artifacts,
frontend upload and project state, tests, and directly affected documentation.
Use one implementation owner because schema and contract are shared surfaces.

Do not add playback, cutting, download, worker, source replacement, revocation,
authentication, or evidence-upload features. Provide the authorization policy
seam and test it; later slices must call it at their boundaries. The concurrent
upload-progress work must be preserved and adapted rather than reverted.

## Exact behavior

1. Upload accepts the deprecated optional `rightsConfirmed="true"` for old
   callers, but always creates exact-version authorization as `NOT_REVIEWED`.
   The normal owned XHR path omits this multipart key completely; no hidden
   `true` or `false` is sent after the checkbox is removed.
2. `GET /api/v1/projects/{id}` exposes the authoritative `authorization`
   object from ADR-003. The deprecated `rights` projection never controls
   access.
3. `PUT /api/v1/projects/{id}/source/authorization` validates literal JSON
   `true`, source readiness, version, and SHA-256; it requires the current
   declaration version only for the first confirmation.
4. After source readiness and tuple matching, an identical confirmation of an
   already-cleared stored declaration returns immutable `200`, even if the
   server's current declaration has rotated. The current declaration check
   applies only to the first `NOT_REVIEWED -> CLEARED` transition. Stale or
   conflicting input returns the documented safe `409` without changing the
   row.
5. The UI removes the upload-time rights requirement, shows the pending gate,
   requires a separate explicit confirmation, and refreshes the project from
   server state after success.
6. The owned policy fails closed unless source ID, version, SHA-256, and
   `CLEARED` all match. Project `SOURCE_READY` alone is insufficient.

## Data acceptance

- Migration backfills every current source as
  `CLEARED / LEGACY_ATTESTATION` using the existing project timestamp and
  declaration version.
- Backfill counts equal source counts; `(sourceId, sourceVersion)` is unique;
  malformed or missing current rights data aborts migration rather than
  guessing.
- New upload persists project, source, source artifact, and `NOT_REVIEWED`
  authorization atomically.
- A failed upload remains non-cleared. No migration or application path writes
  fabricated confirmation data.

## Required tests and evidence

1. Unit: new upload is `NOT_REVIEWED` with and without the deprecated field.
   Assert the owned transport's normal `FormData` does not contain
   `rightsConfirmed`.
2. Unit: policy allows only the exact cleared tuple and denies missing row,
   wrong version, wrong checksum, and `NOT_REVIEWED`.
3. Integration: legacy backfill, new upload, confirmation happy path,
   idempotent repeat, stale tuple, outdated declaration, conflict, not-ready,
   and not-found. Cover declaration rotation explicitly: a repeat matching the
   stored cleared declaration is `200`, while the same old declaration cannot
   perform a first confirmation.
4. Contract: upload field optional/deprecated; response and PUT schemas plus all
   error codes are present; generated JSON and TypeScript have no drift.
5. UI: upload no longer requires the checkbox; pending gate is visible;
   confirmation uses the server tuple; stale/conflict errors remain actionable.
   API persistence and DTO assertions prove that an omitted multipart field
   yields null legacy rights, while literal legacy `true` yields a factual
   attestation but authorization remains `NOT_REVIEWED`.
6. Browser smoke: upload a small fixture, observe `NOT_REVIEWED`, confirm once,
   reload, and observe the same `CLEARED` audit data. Do not repeat the large
   upload merely for this slice.
7. Review: an agent other than the implementer inspects the real migration and
   diff, runs the checks, and reports findings with file/line evidence.

Run with the repository's pinned Node and pnpm environment:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @content-factory/api test
pnpm --filter @content-factory/api test:integration
pnpm --filter @content-factory/web test
pnpm --filter @content-factory/web check:openapi
```

Record the migration command and before/after/backfill counts separately. Test
the migration on an isolated database before applying it to retained local
data. Build the new binary first; then stop the only local API with `Ctrl+C` and
verify `ss -ltn '( sport = :3001 )'` has no listener. Keep it stopped while
taking a fresh snapshot, running the explicit transaction and table locks, and
verifying counts after commit. Start only the new binary. The existing root
snapshot does not replace the fresh quiesced snapshot immediately before this
migration.

## Rollback and handoff

If migration or post-commit counts fail, keep the API stopped and restore the
fresh quiesced snapshot before considering the prior app. Once new
`NOT_REVIEWED` projects exist, retain the additive schema and roll back only to
a compatible build that understands nullable legacy rights and denies access by
default; never start the old binary on the migrated schema.

The implementer must leave changed files, commands, test output, migration
counts, smoke evidence, known limitations, and rollback status in the current
handoff. Independent review must remain marked pending until reproduced.

## Implementation evidence — 2026-09-09

- API unit: 27 tests; web unit: 32 tests; integration: 16 tests, including two
  isolated migration cases. Lint, typecheck, build, format and both OpenAPI
  drift checks passed in the pinned Node/pnpm environment.
- Fresh quiesced snapshot:
  `tmp/recovery/before-source-authorization-20260909T1911.dump` (0600,
  `pg_restore --list` verified). Retained backfill: 3 sources, 3 authorization
  rows, 3 legacy clearances and 3 preserved audit tuples. Only the new built API
  started after migration/count verification.
- `source-authorization.migration.integration.spec.ts` reproduces legacy audit
  preservation and full rollback for malformed legacy input on isolated DBs.
- Review-driven fixes cover required nullable DTO fields, correlated request
  logs, locked source tuple plus confirmation CAS, delayed browser responses,
  tuple-specific checkbox reset and unavailable browser storage.
- Root Chromium smoke passed: actual multipart keys `name/file`, pending gate,
  explicit confirmation, immutable repeat, wrong-checksum denial, durable reload
  and no page errors. Script, JSON and screenshots live under ignored
  `tmp/browser-smoke/authorization-*`.
- Prisma generator output contains trailing whitespace and is intentionally
  excluded from Prettier. No manual generated-code whitespace edits were made;
  `git diff --check` reports only those generated files.
- Independent final review is CLEAN; playback/cutting/download and worker routes
  remain absent until the next accepted slice.
