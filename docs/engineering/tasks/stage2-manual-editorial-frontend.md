# Stage 2 — Manual editorial frontend

## User-visible result

On desktop `/horizontal`, every `READY` cut result has **«Заголовок и
обложка»**. The compact modal loads only the selected project/job’s persisted
editorial package, its available thumbnail assets and reusable template
revisions. An operator can save title, description, ordered newline-separated
tags, select or create a template revision, and upload/select/clear a private
JPEG, PNG or WebP thumbnail. No metadata action creates an FFmpeg job.

The API is the durable source of drafts. Vue Query owns package/template/asset
server data and project-qualified query keys prevent cross-project cache reuse.
The modal gives explicit loading, upload, saving, validation, conflict, retry
and successful-save states. A server-declared incomplete draft remains saveable
and displays its missing fields.

## Conflict and retry behaviour

The user’s current form values are never overwritten by a `409` response. The
feature refetches the latest server revision number and lets the operator save
their retained values deliberately. **«Загрузить сохранённую версию»** refreshes
the package, templates and thumbnails, then applies the saved package to the
form; if the form is dirty, a second explicit click is required before this
replacement. Initial hydration similarly waits for fresh completion of all
three reads, so a cached old package is not shown as the final revision.

Repeating an unchanged save, template-create or thumbnail-upload request uses
its same `Idempotency-Key`; a thumbnail identity includes project ID, original
filename, MIME type, byte size and SHA-256 of its file bytes. Changing a
payload gets a new key. Save disables the
form during its request, and callbacks use captured project/job identities to
ignore late responses for a different dialog.

Client-side thumbnail selection rejects non-JPEG/PNG/WebP MIME types and files
larger than 10 MiB before a request. The backend remains authoritative for
structural image validation and authorization/non-ready/wrong-lineage refusal.

## Changed frontend surfaces

- `apps/web/app/shared/api/editorial-content.ts`: generated-DTO typed API
  adapter with Zod response trust boundary;
- `apps/web/app/features/edit-editorial-package/**`: form validation,
  idempotency identity and dialog workflow;
- `apps/web/app/entities/pipeline-job/ui/pipeline-job-card.vue`: READY-only
  metadata entry point;
- `apps/web/app/widgets/horizontal-workspace/ui/horizontal-workspace.vue`:
  passes exact project/job identity to the feature;
- `apps/web/test/editorial-package-*.spec.ts`: ordered tags, local thumbnail
  rejection, idempotency reuse for save/template/thumbnail, hydration ordering,
  persisted reload/switch isolation, late-response isolation and `409`.

## Verification evidence

Executed from `apps/web` using the existing local dependencies:

```text
./node_modules/.bin/vitest run test/editorial-package-form.spec.ts test/editorial-package-dialog.spec.ts
# 2 files, 14 focused tests passed; full web suite: 12 files, 72 tests passed
./node_modules/.bin/oxlint app test nuxt.config.ts openapi
./node_modules/.bin/nuxt typecheck
./node_modules/.bin/nuxt build
node openapi/contract.mjs check
git diff --check
```

All commands above passed. The usual `pnpm --filter @content-factory/web lint`
entry point was attempted first, but pnpm tried to install dependencies and
stopped because its non-TTY safeguard refused to purge a modules directory; no
dependency, lockfile or generated contract was changed. The direct local
executables exercise the same configured lint/typecheck/build/test tooling.

## Rollback and limits

Functional rollback removes the READY metadata entry point and dialog only;
existing additive package revisions and private `editorial/*` objects remain
untouched. Browser smoke and independent review are intentionally performed by
the orchestrator/reviewer after this frozen frontend diff. Mobile UX, AI,
approval/export and assembly resources are outside this slice.
