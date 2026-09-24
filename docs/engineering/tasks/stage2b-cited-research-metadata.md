# Stage 2B-4a — persisted cited research and exact metadata apply

Status: accepted bounded local slice; admission off by default; independently reviewed

## User-visible result

For a current READY transcript, the operator can create a durable cited local
research suggestion, reload it, edit title/description/tags and apply it to the
current editorial package. Exact unchanged metadata is recorded as
`AI_ASSISTED`; edited metadata is recorded as `MIXED`. The existing thumbnail is
preserved and any approval of the preceding editorial revision becomes stale.

## Acceptance criteria

1. PostgreSQL owns the research intent, immutable normalized HTTPS citations,
   suggestion, attempt, zero-cost local basis and exact transcript/context
   lineage. BullMQ is delivery only and generation runs in the AI worker.
2. Idempotent replay returns the same intent; a reused key with a different
   request returns a generic conflict. Duplicate delivery produces one
   authoritative suggestion.
3. Admission, claim, finalization and apply reject stale source authorization,
   profile/context/prompt or transcript lineage without changing the current
   editorial revision.
4. A successful apply uses `expectedEditorialRevision`, creates one immutable
   revision, preserves thumbnail and thumbnail provenance, and records exact
   metadata provenance. The server derives `AI_ASSISTED` or `MIXED`.
5. Manual metadata, approval and export remain usable when research admission
   is disabled or a research job fails.
6. Public DTOs and logs expose no transcript bytes, storage keys, raw provider
   payload, credentials or private prompt text.
7. Focused migration/API/worker/UI tests, typecheck, lint, OpenAPI drift and one
   local reload/apply smoke provide acceptance evidence. Port 3000 is not used.

## Out of scope

External web fetch/provider credentials, image generation, thumbnail changes,
Twitch, vertical clipping and publication.

## Implementation and verification evidence

- PostgreSQL migrations `20260924100000`, `20260924110000` and
  `20260924120000` install the durable research records, backfill the full
  transcript policy capture and repair the canonical private transcript-key
  constraint without rewriting applied migration history.
- `RESEARCH_TEXT_ENABLED=0` remains the default. A disabled or failed research
  path does not disable the existing manual editor, approval or export paths.
- Focused checks on 2026-09-24: API/worker/web typecheck and lint PASS; OpenAPI
  drift PASS; API 10 focused tests, worker 4 focused tests and web 18 focused
  API/panel/editor tests PASS.
- A disposable PostgreSQL database `cf_research_acceptance_20260924` passed the
  real transcript → research worker → durable reload → exact apply scenario.
  Repeated delivery produced one attempt/suggestion, direct cost remained zero,
  the thumbnail survived revision 2, and revoked source authorization rejected
  the next apply while the package stayed at revision 2.
- The integration smoke exposed and closed three release blockers: incomplete
  frozen transcript policy material, an invalid transcript object-key CHECK,
  and timezone-dependent JavaScript lease comparisons.
- Independent review of the real diff is CLEAN. Its final rights-gate finding
  was closed by passing the runtime source-authorization policy into the worker
  and rejecting `LOCAL_DEVELOPMENT_AUTO` during claim and finalization whenever
  the active policy is `manual`.

## Rollback

Keep `RESEARCH_TEXT_ENABLED=0` to stop new admissions without removing durable
history. The schema changes are additive; application rollback must leave the
new tables/columns and repair constraints in place. Existing manual revisions,
thumbnails, approvals and exports do not depend on research rows.
