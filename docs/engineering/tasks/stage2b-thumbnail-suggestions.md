# Stage 2B-5a — durable no-likeness thumbnail suggestions

Status: accepted after independent CLEAN review; admission off by default

## User-visible result

For a current READY cut with current creator context and cut prompt, the
operator can request a private deterministic thumbnail candidate, reload it,
preview it and apply the exact candidate to the current editorial package.
Apply creates a new immutable editorial revision with independently derived
`AI_ASSISTED` thumbnail provenance while preserving metadata exactly. The
existing manual thumbnail upload remains available at all times.

## Acceptance criteria

1. PostgreSQL owns the image intent, attempts, exact context/cut lineage,
   candidate identity, checksum, dimensions, storage receipt, local zero-cost
   basis and terminal failure. BullMQ is delivery only; candidate generation
   runs in the AI worker.
2. The first adapter is provider-neutral, local and deterministic. It creates a
   PNG without a realistic person or reference-image input. It performs no
   network/provider call and records `likeness=NONE`.
3. Admission, worker claim, finalization and apply recheck current source
   authorization, cut bytes, profile/context/prompt revisions and runtime
   source-authorization policy. Stale or revoked input cannot become selectable.
4. Candidate bytes are private, bounded, structurally inspected before READY
   and available only through a project/cut-scoped content endpoint with bounded
   Range behavior. DTOs and logs expose no object key or bytes.
5. Duplicate delivery creates one authoritative candidate. Same idempotency key
   with the same canonical request returns the same intent; changed input gives
   a generic conflict. Redis loss is recovered from PostgreSQL.
6. Exact apply atomically materializes one READY `EditorialAsset`, creates one
   editorial revision, preserves title/description/tags and their provenance,
   records exact image intent/candidate provenance and makes a preceding
   approval stale through normal revision advancement. Replay creates neither a
   second asset nor a second revision.
7. Manual upload/save/preview/approval/export remain usable when image admission
   is disabled or generation fails. Candidate preview alone never changes the
   current editorial revision or approval.
8. Migration, typecheck, lint, OpenAPI drift, focused API/worker/UI tests,
   controlled stale/failure tests and one disposable PostgreSQL/object-storage
   reload/apply smoke provide acceptance evidence. Port 3000 is not used.

## Explicitly deferred

Realistic likeness and reference transfer, external image providers, paid
cost reservation, candidate pixel editing/`MIXED`, manifest v2, Twitch,
vertical clipping and publication are deferred. A realistic-likeness path needs
the separate provider privacy/rights review required by ADR-008.

## Rollback

Keep `THUMBNAIL_SUGGESTIONS_ENABLED=0` to stop new admission. Durable rows and
private historical candidate objects remain in place. Existing manual
thumbnails, editorial revisions, approvals and exports do not depend on the new
tables or queue.

## Verification evidence — 2026-09-24

- Prisma schema validation, client generation and migrations through
  `20260924170000_image_suggestion_upload_lifecycle` pass against the disposable
  `cf_research_acceptance_20260924` database.
- API, worker and web typechecks and linters pass. OpenAPI JSON and its generated
  TypeScript client are current.
- Focused worker tests pass `11/11`; image content boundary tests pass `3/3`; the
  thumbnail API/panel/editor dialog tests pass `18/18`.
- The real PostgreSQL + private MinIO smoke passes. It covers durable reload,
  duplicate delivery, exact apply, project isolation, revoke/content gates,
  mutation between resolve and apply, exact replay after revoke,
  cross-operation idempotency collision, provenance carry-forward and reuse of
  one candidate-backed asset.
- Lease-recovery tests prove attempt-scoped object fencing, late-failure
  fencing, stable public failure codes and durable cleanup completion/retry.
- Port `3000` was not used. Admission remains disabled by
  `THUMBNAIL_SUGGESTIONS_ENABLED=0`.
