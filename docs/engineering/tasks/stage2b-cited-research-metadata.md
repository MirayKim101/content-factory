# Stage 2B-4a — persisted cited research and exact metadata apply

Status: implementation in progress; admission off by default

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
