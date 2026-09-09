# Stage 2B-1 — Creator Context Workspace: independent QA acceptance

Статус: **план проверок, не выполнен**. Этот файл не является evidence
выполнения. Проверки ниже выполняет независимый reviewer после завершения
frontend diff; implementer не засчитывает их как self-review.

## Scope and oracle

Проверяется только desktop UI Stage 2B-1 и его API wrapper against frozen
OpenAPI. Oracle: `docs/engineering/tasks/stage2b-creator-context-foundation.md`
(Frontend acceptance and controlled failures), ADR-008 and the generated
`apps/web/openapi/openapi.json`. No provider, ai-worker, Redis/BullMQ, new job,
or external call belongs to this acceptance.

The reviewer first records the exact frontend diff, runs focused unit/component
tests plus typecheck/lint/build/OpenAPI drift, then performs the browser smoke
using a disposable profile and existing authorized local source/cut. Do not
run broad API integration suites against working local data for this frontend
review.

## Contract blocker before execution

**BLOCKER — frozen generated contract cannot type the required UI mutations.**

The following operations in `apps/web/openapi/openapi.json` have no
`requestBody`; several also have no declared path parameters. Generated
`apps/web/app/shared/api/generated/openapi.ts` consequently exposes
`requestBody?: never` / `path?: never`:

| Required mutation                                                                         | Missing generated contract data                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `PUT /creator-profiles/{profileId}`                                                       | body `UpdateCreatorProfileDto`                             |
| `PUT /creator-profiles/{profileId}/reference-assets/{assetId}/authorization`              | body `UpdateCreatorReferenceAuthorizationDto`; path params |
| `PUT /creator-profiles/{profileId}/default-reference`                                     | body `SetDefaultCreatorReferenceDto`; `profileId`          |
| `PUT /projects/{projectId}/sources/{sourceId}/versions/{sourceVersion}/editorial-context` | body `PutSourceEditorialContextDto`; path params           |
| `PUT /pipeline-jobs/{cutJobId}/editorial-prompt`                                          | body `PutCutEditorialPromptDto`; `cutJobId`                |

The Nest controller methods accept these DTOs, but lack the corresponding
Swagger `@ApiBody` annotations (and path metadata where omitted). Until the
backend contract is corrected and OpenAPI regenerated, frontend code must either
use unsafe `Record<string, unknown>` or duplicate request/response schemas.
Both violate the frozen-contract acceptance: generated OpenAPI types must not
be duplicated. This blocks CLEAN acceptance; it is not a reason to broaden the
frontend wrapper with local shadow contracts.

## Focused regression probes

### P0 — private profile round-trip and redaction

1. Mock a profile list summary without `editorialNotes`/`restrictions`, then
   open the selected profile and resolve private detail containing both fields.
   Edit a visible field and save. Assert outgoing full PUT includes the exact
   original private values, `expectedRevision`, and the idempotency key.
2. Reload the profile after save and assert all editable fields, normalized
   official URL, current revision, and default-reference snapshot hydrate from
   detail. Assert the list UI never renders private notes, restrictions,
   declaration text, object key, or storage credentials.
3. Return `409 CREATOR_PROFILE_OFFICIAL_URL_CONFLICT` with
   `existingProfileId`. Assert the UI offers only navigation/open of that
   profile and does not merge, overwrite, or retry with a different key.
4. Use a `NOT_REVIEWED` asset response. Assert it is labelled as not approved;
   the UI explicitly distinguishes official/source rights from likeness rights.

### P0 — exact revision, stale chain, and durable mutation retry

1. For profile, source-context, and cut-prompt saves, create the request twice
   after a simulated lost/network response. Assert the canonical unchanged
   request reuses one idempotency key. Change body, target, source version, or
   operation and assert it creates a fresh key rather than replaying the old
   key.
2. Return `409` for a stale `expectedRevision`. Assert typed conflict feedback
   preserves form contents, fetches the newest server revision, and exposes an
   explicit reload action. It must never issue a force overwrite.
3. Hydrate a `STALE` source context/prompt containing blocker codes after an
   upstream profile revision changes. Assert the screen shows the blocker and
   requires an explicit next source-context or prompt revision; it must not
   silently substitute the profile/current context revision.
4. Drive two source versions for one source through delayed promises. Resolve
   the old-version request after switching to the new version. Assert query
   keys include `(projectId, sourceId, sourceVersion)` and no old response
   replaces the new screen.

### P0 — reference authorization, explicit default and revoke

1. Upload a valid JPEG/PNG/WebP through multipart once. Verify the returned
   asset is previewed using only the private API content route, is
   `NOT_REVIEWED`, and profile default remains null.
2. Submit the separate `CLEARED` attestation with all explicit values. Assert
   it changes only authorization; no default-selection request occurs.
3. Press “use by default” explicitly. Assert the request carries current
   `expectedProfileRevision`, exact `assetId`, exact authorization revision ID
   and number, then UI shows `CLEARED_REFERENCE_ONLY` only after successful
   response.
4. Return stale/non-cleared selection `409`. Assert the prior state remains
   visible and the UI asks to reload/select a current cleared authorization.
5. Revoke the authorization with a separate explicit action. Assert the
   current status becomes `REVOKED`, likeness is unavailable with the backend
   blocker, history remains readable, and text/context/manual UI is not
   disabled.

### P1 — dirty state, close/switch and failure boundary

1. Change any profile/context/prompt field, then close its dialog and switch
   project/source/cut. Assert a visible discard-or-stay decision is required;
   no dirty form is silently erased.
2. With no dirty state, switch project/source and assert all dialogs and
   project-scoped cache are reset. Resolve old in-flight list/detail/mutation
   promises afterwards; assert they cannot alter the new target or surface
   success/error there.
3. With `AI_CONTEXT_ENABLED=0`, API `503`, or an initial context-query
   failure, assert creator-context entry points/actions are hidden or show a
   bounded retry error. Manual metadata, thumbnail, preview, approval, export
   and their existing action paths remain available and callable.

### P1 — manual provenance regression

1. Load a new manual editorial package whose response contains
   `provenance.metadata.mode = MANUAL` and
   `provenance.thumbnail.mode = MANUAL`; assert two independent visible badges.
2. Load a legacy basis (`legacy-manual-editorial-v1`); assert the tooltip/text
   identifies legacy manual basis without inventing `AI_ASSISTED` or `MIXED`.
3. Save a manual package after creator-context activity. Assert the normal
   manual payload does not carry provenance mode, returned badges remain
   `MANUAL/MANUAL`, and the existing preview/approval/export controls do not
   become stale solely because a profile/reference was changed or revoked.

## Required reproducible evidence

Record command output and test names for:

1. focused new API-wrapper/form/component tests covering every P0 probe;
2. `pnpm --dir apps/web test --run <focused files>`;
3. `pnpm --dir apps/web lint`, `pnpm --dir apps/web typecheck`, and
   `pnpm --dir apps/web build`;
4. OpenAPI generation/drift check and `git diff --check`;
5. browser smoke IDs/revisions and visible states for create → private reload →
   upload → clear → explicit default → source-context → cut prompt → stale →
   revoke → manual package/preview/approval/export.

Any environment-dependent failure (especially local API flag or retained
working data) must be recorded as such, with the exact command and observed
result. CLEAN requires the contract blocker above to be resolved first.
