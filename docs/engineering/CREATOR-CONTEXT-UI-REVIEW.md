# Stage 2B-1 Creator Context UI — independent review

Date: 2026-09-16. Reviewer status: **CLEAN for the Stage 2B-1 Creator Context
UI slice**. Static behavior, upload retry/storage policy, bounded desktop layout,
manual fallback, and the live browser workflow have passed their separate
review gates. This is not acceptance of later AI generation stages or the full
Content Factory MVP.

## Scope and authority

This review used the acceptance criteria in
[tasks/stage2b-creator-context-foundation.md](tasks/stage2b-creator-context-foundation.md),
[tasks/stage2b-creator-context-qa.md](tasks/stage2b-creator-context-qa.md), and
ADR-008. The reviewer inspected the real frontend, API failure handling, MinIO
policy, and tests. Implementation reports were treated as context rather than
acceptance evidence.

The reviewed frontend scope covered profile private-detail round-trip, exact
revision CAS, dirty-draft protection, durable mutation identities, reference
authorization/default/revoke, exact source context and cut-prompt bindings,
late-response isolation, generated OpenAPI types, manual provenance, and the
feature-disabled fallback. The later narrow review covered terminal versus
ambiguous reference-upload outcomes and least-privilege MinIO access.

Protected external directories and their resources were not accessed. The
reviewer made no product, API, schema, infrastructure, or runtime configuration
changes.

## Findings and disposition

The initial real-diff review found three frontend defects:

1. A failed profile-catalog read had no retry action, so the catalog remained
   unavailable until a full page reload. The repair adds an explicit retry and
   preserves an unsaved profile draft. A component regression proves that no
   create or update mutation occurs during the retry.
2. Authorization fields could be edited while their request was pending, but a
   preserved draft kept the old authorization base revision. Its next save
   therefore produced a deterministic self-conflict. The repair advances the
   draft only to the exact revision returned by its own successful request. A
   later unrelated query revision is not adopted and still fails closed through
   CAS.
3. Selecting or clearing a default reference while descriptive profile fields
   were dirty created a new profile revision without advancing the form base.
   The following profile save then conflicted with the UI's own revision.
   Default changes now require descriptive edits to be saved or explicitly
   reloaded first, and profile/default mutations cannot run concurrently.

The reviewer also required reload to wait for both profile and reference reads
before clearing drafts. This prevents authorization controls from being
rehydrated against a pre-reload revision. All four repairs were inspected in the
real code and exercised by focused component tests.

The first live reference upload then exposed two separate runtime issues:

- MinIO denied the API-owned
  `ai-content/creator-profiles/*/references/*` namespace. Provisioning now grants
  only Get, Put, Delete, abort-multipart, and list-multipart-parts actions for
  that namespace. It does not add an object-wide bucket wildcard or access to an
  unrelated `ai-content` prefix.
- The browser reused the same upload identity after a confirmed
  `FAILED_FINAL`, making a manual retry replay the failed asset forever. The API
  now returns `CREATOR_REFERENCE_OUTCOME_UNKNOWN` when persistence of the
  terminal failure is not confirmed and leaves the object for reconciliation.
  The frontend retires a key only for typed terminal
  `CREATOR_REFERENCE_STORAGE_FAILED` or
  `CREATOR_REFERENCE_FINALIZE_FAILED`; network, generic server,
  `UPLOAD_IN_PROGRESS`, and `OUTCOME_UNKNOWN` responses retain the exact key.
  A new request occurs only after the user's next explicit upload click.

The narrow API/frontend/policy re-review found no remaining actionable issue.
Commit `b55bd5c` contains the accepted API and MinIO-policy correction; the
frontend was still uncommitted when this evidence was recorded.

## Independent automated evidence

Commands used the repository's pinned Node 24.15.0 and pnpm 10.34.5 toolchain.

### Static frontend gate before the upload-retry addition

- `pnpm --dir apps/web test`: **33 files, 185 tests passed**.
- `pnpm --dir apps/web typecheck`: passed.
- `pnpm --dir apps/web lint`: passed.
- `pnpm --dir apps/web check:openapi`: generated JSON and TypeScript artifacts
  matched the Nest contract.
- `pnpm --dir apps/web build`: production Nuxt build passed.
- `git diff --check`: passed.

This gate independently covered private detail hydration and round-trip,
redacted catalog data, cross-profile and cross-source isolation, exact loaded
revision CAS, durable retry identities, rights/default/revoke separation,
independent source/prompt drafts and explicit binding, query-error boundaries,
dirty navigation guards, generated DTO types, disabled-feature manual fallback,
and separate metadata/thumbnail `MANUAL` provenance.

### Narrow upload-outcome and storage-policy gate

After the retry changes, the implementation's complete frontend run was **33
files, 192 tests passed**. The reviewer did not repeat that entire suite because
the preceding 185-test gate was already complete; the independent repeat was
limited to the changed behavior:

- API focused run:
  `creator-reference-failure-outcome.spec.ts` plus `minio-policy.spec.ts` —
  **2 files, 6 tests passed**. Five cases cover storage/finalization failure,
  confirmed versus unknown failure persistence, cleanup ordering, and a READY
  finalization whose response was lost. The policy case asserts the three exact
  owned object namespaces and rejects the unrelated probe namespace.
- Frontend focused run:
  `creator-context-components.spec.ts` plus
  `creator-context-attempt-storage.spec.ts` — **2 files, 27 tests passed**.
  These include retention for four ambiguous errors, rotation for two terminal
  errors, explicit-click-only retry, and late-error protection for newer and
  other-profile identities.
- `sh -n infrastructure/minio/provision` and scoped `git diff --check`: passed.

The orchestrator separately recorded the final complete runs after these narrow
changes: frontend **33/192**, API **31 files/128 tests**, API typecheck, lint,
build, formatting, and Creator Context integration **2/2**. Those complete-run
results are supporting orchestration evidence; the focused results above are
the reviewer's independent reproduction.

## Independent live MinIO evidence

Before probing, the reviewer asserted the exact container identity and health:

```text
content-factory-restored|minio|running|healthy
```

Using only the restored Compose project and its API storage identity:

- a random object under
  `ai-content/creator-profiles/<uuid>/references/<uuid>/probe` was written,
  read with `stat`, deleted, and confirmed absent;
- a write to a random `ai-content/unrelated-denied-probe-review-*` key was
  denied, and an administrator read confirmed that no object existed;
- unauthenticated HTTP access to a known existing private creator-reference
  object returned `403 AccessDenied`.

No credentials were printed. The probe object was removed. The reviewer did not
restart services. The startup reconciler's cleanup of the original failed asset
and the positive private API upload/content checks are recorded separately in
[RESTORED-CREATOR-REFERENCE-STORAGE-SMOKE.md](RESTORED-CREATOR-REFERENCE-STORAGE-SMOKE.md).

## Browser acceptance and bounded-layout review

The first live browser run confirmed profile creation/use, reference upload,
authorization, explicit default selection, private reload, and the
storage-policy repair. It also found that the real Creator Context dialog was
unstyled or taller than the available viewport, leaving required controls
beyond the visible area. Browser acceptance remained open at that point.

The bounded repair uses component-prefixed PrimeVue pass-through classes. The
dialog root is a height-bounded flex column, its header remains fixed, and only
the content region scrolls. The private profile selector overlay has its own
bounded list and higher stacking level. The reviewer inspected the real diff and
repeated focused checks:

- `creator-context-components.spec.ts`: **1 file, 24 tests passed**;
- web typecheck and lint: passed;
- scoped `git diff --check`: passed;
- Chromium at `1440x900`: dialog bounds `x=224`, `y=16`, `right=1216`,
  `bottom=884`; body `797/1888` px visible/content, `overflow=auto`, no document
  horizontal overflow;
- Chromium at `1280x720`: dialog bounds `x=144`, `y=16`, `right=1136`,
  `bottom=704`; body `617/1888` px visible/content, `overflow=auto`, no document
  horizontal overflow;
- at both viewports the selector worked, the lower prompt save action became
  reachable through normal scrolling, the header stayed visible, close/discard
  worked, and no page error occurred;
- the final PrimeVue close-button pass-through exposed the exact accessible name
  `Закрыть контекст`; the reviewer located and activated it by role and name with
  an ordinary click;
- a separate read-only `1280x720` check used ordinary clicks to open and close
  Creator Context, then open the existing manual editorial dialog. It confirmed
  `Метаданные: MANUAL` and `Обложка: MANUAL`, with no page error or mutation.

The orchestrator then completed the full live sequence with ten successful
mutations: private profile round-trip/redaction, reference upload, explicit
authorization/default/revoke, exact source-context and prompt save/reload,
stale detection and explicit rebind. The existing manual ZIP retained its
accepted SHA-256. Exact fixture IDs, steps, screenshots, rollback, and limits are
recorded in
[CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md](CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md).

No actionable finding remains in this slice. Stage 2B-1 Creator Context UI and
its local runtime storage support are **CLEAN** for freeze and handoff.
