# Stage 2B-1: Creator Context UI repair

Date: 2026-09-16. Status: implementation and automated frontend checks complete;
independent review and browser acceptance are separate gates. This document is
not a CLEAN approval or evidence of provider/AI generation functionality.

## Scope and authority

Implements the existing frontend acceptance in
[tasks/stage2b-creator-context-foundation.md](tasks/stage2b-creator-context-foundation.md)
and [tasks/stage2b-creator-context-qa.md](tasks/stage2b-creator-context-qa.md), under
ADR-008. This frontend owner changed no backend, generated contracts, schema,
migrations, dependencies, provider adapters or worker behavior. The final upload
retry behavior depends on the separately owned backend correction described below.

One owner repaired the creator profile workspace, context dialog, API wrapper,
form/retry models, minimal horizontal workspace dirty guards and focused tests.
Protected directories and associated resources were not accessed.

## Repaired behavior

- Private profile detail hydrates before editing. Confirmed profile switches
  reset drafts before loading another profile; redacted summaries never supply
  editable private fields.
- Profile/source-context/prompt forms keep the revision they actually loaded.
  Background query refresh cannot silently advance their compare-and-set base.
  Conflicts preserve drafts and offer explicit reload; duplicate official URL
  offers navigation without automatic selection, merge or overwrite.
- Mutation requests capture their target, revision, body, retry key and screen
  identity. Late responses refresh only their own cache and cannot replace the
  current target or display its success/error. Unmount invalidates the screen
  identity. Pending query responses are cancelled before committing mutation
  results to the matching cache.
- Reference upload uses filename/type/size plus SHA-256 of the actual bytes for
  durable retry identity. Rights, default selection and revoke also reuse exact
  operation/target/body keys across ambiguous failures. Completion removes only
  its matching stored key, preserving any newer operation.
- A confirmed terminal upload error (`503 CREATOR_REFERENCE_STORAGE_FAILED` or
  `CREATOR_REFERENCE_FINALIZE_FAILED`) retires only that request's matching key.
  The next explicit «Загрузить фото» click starts a new attempt; there is no
  automatic upload request or automatic retry. Network errors, generic 500,
  `CREATOR_REFERENCE_UPLOAD_IN_PROGRESS` and
  `CREATOR_REFERENCE_OUTCOME_UNKNOWN` retain the exact retry identity. Late
  terminal responses cannot clear another profile's key, a newer same-profile
  key, or display feedback on another screen. This classification requires the
  orchestrator-owned service correction: failure to persist `FAILED_FINAL` must
  raise `OUTCOME_UNKNOWN`, never a terminal storage/finalization code. The prior
  service swallowed that persistence failure, so rotating solely on its old
  error semantics would have been unsafe.
- Upload, authorization and explicit default selection stay independent.
  Revoke refreshes profile, catalog, reference and authorization history caches.
  The workspace displays exact default authorization version, authoritative
  likeness availability/blocker, and readable authorization history. Default
  can also be explicitly cleared. If authorization fields are edited while a
  request is pending, the draft remains visible and advances only to that exact
  successful authorization response version; a newer unrelated query revision
  still conflicts. Default selection/clearing requires descriptive profile edits
  to be saved or explicitly reloaded first. Profile/reference mutations cannot
  run concurrently; descriptive fields are disabled while they are pending.
  Explicit reload waits for both profile and reference reads before discarding
  drafts, preventing a draft from being re-created against the pre-reload rights
  revision. These self-conflict fixes follow independent reviewer findings.
- Source and prompt drafts have separate dirty snapshots. Saving one does not
  discard the other. Existing prompt bindings stay on their exact context
  revision until the operator explicitly rebinds them.
- Dialog close, profile creation/switch, navigation and horizontal source/project
  changes consult discard-or-stay guards. A refused source-change dismissal
  preserves the old dialog/draft; it does not silently attach it to the new
  source. Browser unload also protects dirty drafts.
- Initial 404 absence permits creation. Network/503/read failures show a bounded
  retry state rather than pretending saved private data is empty. AI-disabled
  behavior preserves the independent manual workflow. A failed catalog has an
  explicit «Повторить загрузку каталога» action; successful retry preserves any
  active profile draft. This was added after independent reviewer feedback.
- Rights/default mutation bodies now use generated DTO types, replacing broad
  `Record<string, unknown>`. Zod continues validating forms and raw responses;
  official links require HTTPS without credentials/query/fragment.
- New user-facing labels and feedback use Russian; exact policy/blocker codes
  remain visible as diagnostic details.

## Automated evidence

Commands use the existing pinned Node 24.15.0 / pnpm 10.34.5 toolchain. No
installation or version change was needed.

- `pnpm --dir apps/web test`: **33 files, 192 tests passed**.
- `pnpm --dir apps/web typecheck`: passed.
- `pnpm --dir apps/web lint`: passed.
- `pnpm --dir apps/web build`: passed after the reviewer fixes. An intermediate
  parent event-expression parse failure was fixed before delivery.
- `pnpm --dir apps/web check:openapi`: passed; generated artifacts match Nest.
- Focused formatting and owned-file `git diff --check`: passed.

Reproducible local command logs: `tmp/creator-ui-tests-all.log`,
`tmp/creator-ui-typecheck.log`, `tmp/creator-ui-lint.log`,
`tmp/creator-ui-build.log`, `tmp/creator-ui-format-check.log`,
`tmp/creator-ui-openapi.log`. Logs are local evidence,
not tracked artifacts.

The creator component suite additionally covers four ambiguous upload errors,
two terminal upload errors with explicit next-click rotation, and late-error
isolation with and without a newer same-target key.

New suites `creator-context-components.spec.ts` and
`creator-context-api.spec.ts` cover private detail round-trip, redacted summaries,
exact CAS through background refetch, lost-response retries, explicit URL
conflict navigation, late profile success isolation, dirty navigation,
NOT_REVIEWED → CLEARED → explicit default → REVOKED with retained history,
private content URL, multipart upload identity, source-version isolation,
independent dirty sections, explicit stale binding, 404 vs 503, disabled context,
form validation and typed request boundaries. Existing retry-storage tests were
corrected to spy on the actual browser storage instance. Horizontal workspace
adds a dirty-source-switch probe; editorial dialog adds independent MANUAL and
legacy-basis badges with a payload assertion excluding provenance.

## Browser smoke selectors

The orchestrator owns runtime flag changes and live browser acceptance; the
implementer does not change `.env` or services.

1. `/creator-context`: button `Создать профиль`; labels `Имя`,
   `Официальная ссылка`, `Язык`, `Темы, одна на строку`, `Личные заметки`,
   `Ограничения, одна на строку`; button `Создать` or `Сохранить новую версию`.
2. Selected profile: `input[type=file]`, button `Загрузить фото`; reference
   preview is an image sourced exclusively from the private API content route.
3. Rights labels: `Основание`, `Область разрешения`,
   `Срок действия (необязательно)`;
   `input[id^="attest-"]` and `input[id^="transfer-"]`; button
   `Подтвердить разрешение`. Each reference has its own rights draft/checkbox IDs.
4. Buttons `Использовать по умолчанию`, `Убрать фото по умолчанию`,
   `Отозвать разрешение`, `История разрешений`. Availability is displayed in
   `[data-testid="likeness-status"]`; history in
   `[aria-label="История разрешений"]`.
5. `/horizontal?projectIds=<project>`: the existing ready-cut context action
   opens the dialog. Source labels include `Профиль`, `Версия профиля`,
   `Название исходника`, `Игра или тема`, `Аудитория`, `Редакционная цель`,
   `Язык`, `Призыв к действию по умолчанию`, `Личные заметки`.
   Save with `Сохранить контекст исходника`.
6. Prompt labels: `Что происходит`, `Желаемый акцент`, `Тон`,
   `Призыв к действию`, restrictions. Use `Связать с текущей версией контекста`
   when offered, then `Сохранить инструкцию к нарезке`.
7. On conflict: `Загрузить актуальную версию`; duplicate URL offers
   `Открыть существующий профиль`. Native confirmation presents discard/stay.
8. Verify existing manual metadata/thumbnail, preview, approval and export
   before/after context/reference changes. Automated tests do not substitute
   for this real browser sequence.

## Rollback and limits

Keep `AI_CONTEXT_ENABLED=0` and the corresponding public frontend flag disabled
until the orchestrator completes independent review/browser acceptance. Rollback
is admission-off plus the previously accepted forward-compatible frontend/API;
no rows, reference images, revisions or existing manual artifacts are deleted.

No provider calls, AI generation jobs, Twitch, vertical clipping or publication
were added. Runtime acceptance, exact live IDs/revisions and independent reviewer
findings belong in the current handoff/review evidence rather than being inferred
from this implementation report.

## Browser layout follow-up

The real browser smoke exposed an unstyled PrimeVue dialog: the panel had no
opaque surface or bounded scroll area, so its profile selector was outside the
viewport. The repair is limited to `creator-context-dialog.vue`: component-owned
pass-through classes and global styles follow the existing manual editorial
editor convention, with an opaque backdrop/panel, bounded viewport height,
stationary header, scrollable content, and visible form/select controls. The
close button uses the installed PrimeVue `pcCloseButton.root` pass-through and
an explicit «Закрыть контекст» accessible name. No shared style or contract changed.

A separate read-only layout probe used normal browser interactions at 1440×900
and 1280×720, without forced clicks or altered viewport workarounds. Both passed:
profile dropdown selection, lower prompt field access, close/discard, opaque
background, bounds inside the viewport, no horizontal page overflow and no
JavaScript errors. At 1280×720 the panel occupies y=16…704 and its 617px content
area scrolls over 1888px of form content. This probe did not save any API mutation.

Evidence: `tmp/creator-browser/layout-check.cjs`, `layout-check.log`,
`layout-evidence.json`, `layout-1440.png`, `layout-1280.png`. The initial selector
probe also caught an outdated close-button pass-through copied from the manual
editor; it was corrected locally before the successful final probe. Focused
creator component tests, typecheck and lint were rerun after the layout change.
The orchestrator separately owns the full live workflow acceptance evidence.
