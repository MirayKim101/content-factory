# Exact-source authorization — independent review

Date: 2026-09-09. Verdict: **CLEAN**, no actionable findings remain.

Reviewer: `authorization_review`, separate from implementation owner
`source_authorization`. The orchestrator recorded this report from the reviewer's
final evidence; the reviewer made no production, schema, configuration or
documentation edits.

## Scope inspected

Final real diff against ADR-003 and the recovery task: schema and transaction
migration; repository source lock/confirmation CAS; DTO/controller/request logs;
policy; XHR/UI/browser storage and stale responses; tests and affected docs.

## Independently reproduced

Pinned Node 24.15.0 / pnpm 10.34.5:

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed.
- API unit: 27/27; web: 32/32; API integration: 16/16.
- Isolated migration tests preserved three legacy audit rows and fully rolled
  back malformed-input migration.
- API and web `check:openapi`: no drift.
- Chromium: multipart keys only `name/file`, `rights=null`, `NOT_REVIEWED`,
  separate explicit confirmation to `CLEARED`, immutable 200 replay,
  wrong-checksum 409, reload persistence and zero page errors. Pending/restored
  screenshots were visually inspected.
- Read-only retained database counts after smokes: six sources, six
  authorizations, three legacy clearances, three preserved legacy audits.
- Fresh pre-migration snapshot has mode 0600; independent `pg_restore --list`
  succeeded and showed the pre-migration tables.

Browser project: `b0b78873-09e9-491c-a671-a4f41542a2ac`. Repeatable browser harness
and local evidence live under ignored `tmp/browser-smoke/`; durable regression
tests live under the API and web test directories.

## Findings fixed and verified

Required nullable OpenAPI fields, request correlation logs, exact-source
`FOR UPDATE` lock, automated migration evidence, delayed UI response guards,
confirmation-specific error instructions and degraded browser storage handling.

## Limits

Prisma's generator emits trailing whitespace in generated files excluded by
`.prettierignore`. `git diff --check` reports that generator output only; the
required format check passes. No manual generator-output edits were requested.

Playback, cutting, download and worker routes are the next slice. This review
accepts their fail-closed authorization seam, not nonexistent route behavior.
The additive schema remains on rollback; new nullable-rights rows require a
compatible binary. Never restart the prior upload-only build on this database.
