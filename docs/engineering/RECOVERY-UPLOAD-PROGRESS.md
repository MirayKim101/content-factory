# Recovery slice: measured upload progress

Status: accepted after independent review, 2026-09-09.

## User result

Show measured transfer progress for the existing single MP4 upload and clearly
separate transfer completion from server validation and storage finalization.
This is the first bounded recovery slice while the newer Mac code is unavailable.

## Authority and scope

- Owner requests autonomous restoration toward MVP with quota checks and a stop
  at 50% used. Protected directories remain strictly excluded by `AGENTS.md`.
- Read `00-PROJECT-SUMMARY.md`, `01-ARCHITECTURE.md`, `ARCHITECTURE.md`,
  `docs/product/MVP-ROADMAP.md`, ADR-001 and ADR-002.
- Latest UX requirements: [Notion backlog](https://app.notion.com/p/3cff0d44c82d81bd9f5ac01270044f67).
- Architect approved a progress-only slice inside the existing baseline.
- Keep the current rights checkbox behavior for this slice. Exact-version
  authorization, library, cutting, multi-file queue, dependencies, schema and
  API contract changes belong to subsequent slices.

## Ownership

One frontend implementer owns `apps/web/app/shared/api/` (excluding generated
files), `apps/web/app/features/upload-source/`,
`apps/web/app/widgets/source-upload/`, relevant `apps/web/test/` files and the
evidence section of this document. Other files require orchestrator coordination.
Do not revert other agents' changes or touch user `.idea/` or `package-lock.json`.

## Acceptance

1. An owned typed XHR adapter measures uploaded bytes, total bytes, percent,
   approximate transfer speed and ETA. Components contain no raw transport.
2. If progress is not computable, show an indeterminate transfer state rather
   than invented percentages. Label estimates as approximate.
3. Completion of byte transfer shows server validation/storage finalization
   until the response or existing status polling reports a terminal state.
4. Preserve safe errors, same-key retry after an unknown network outcome,
   reload recovery, double-submit protection and stale-attempt protection.
5. Clear progress for a new attempt; late events must not update another attempt.
6. Test meaningful progress/finalization/error transitions and transport errors.
   Run a small-fixture browser smoke when infrastructure is ready.
7. Keep generated OpenAPI unchanged. No new dependency or migration is needed.

## Verification

Use the local Node 24 / pnpm runtime documented in
`docs/infrastructure/linux-readiness.md` once available.

```sh
pnpm --filter @content-factory/web test
pnpm --filter @content-factory/web lint
pnpm --filter @content-factory/web typecheck
pnpm exec prettier --check docs/engineering/RECOVERY-UPLOAD-PROGRESS.md
git diff --check
```

Independently review the real diff and reproduce relevant checks before acceptance.

## Rollback

Revert only this frontend slice. No database or stored media changes are involved.
If newer Mac code arrives, pause this slice and compare implementations first.

## Implementation and review evidence

Independent reviewer reproduced the full web suite (23 tests), lint, typecheck,
format checks and `git diff --check`: no findings. API baseline also passed
22 unit and 12 integration tests; both API and frontend OpenAPI checks passed.

Real Chromium smoke was reproduced independently against WSL API/web and Docker
Desktop storage: measured transfer (16 KiB / 258 KiB, 6%, speed and ETA), exact
server-finalization message, HTTP 201 `SOURCE_READY`, and a corrupted MP4 giving
HTTP 415 with a safe message. No JavaScript page errors. The independent run's
project ID is `77ffade0-a07b-4553-8b44-2fefe0d13f9f`; the tiny source is retained.
Local screenshots, evidence JSON and the repeatable browser scenario are in
ignored `tmp/browser-smoke/`. Playwright 1.63.0 is installed there only, following
the [official library instructions](https://playwright.dev/docs/library).

Implementation, 2026-09-09:

- `projects.ts` owns the multipart XHR transport and emits measured bytes,
  computable percent, approximate speed/ETA, transfer completion, and a safe
  network error. The widget contains no transport events.
- The feature clears progress for a fresh attempt and ignores events from an
  invalidated attempt. XHR upload completion changes the UI to server
  validation/storage finalization before the API response arrives.
- Focused web verification passed with Node 24 / pnpm 10.34.5:
  `pnpm --filter @content-factory/web test -- projects-api source-upload`
  (23 tests), `pnpm --filter @content-factory/web lint`, and
  `pnpm --filter @content-factory/web typecheck`.
- `git diff --check` passed. Browser smoke and independent review remain
  required before acceptance.
