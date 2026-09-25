# Stage 2B-3 — transcript evidence and local AI-worker foundation

Status: accepted; implementation, live recovery evidence and independent review complete

This slice adds a provider-neutral transcript evidence boundary after the
accepted sparse-frame slice. It keeps the existing manual editorial path
available when no transcript adapter is configured.

## Acceptance criteria

1. An exact READY cut can create one idempotent transcript intent bound to the
   current creator profile, source context and cut prompt revisions.
2. PostgreSQL owns the intent, immutable input capture, attempt state, segment
   metadata, checksums, adapter version and controlled terminal failure.
3. Transcript work is delivered asynchronously to the `ai-transcript-v1`
   BullMQ queue and consumed by the worker's deterministic local adapter. HTTP
   never performs transcription. Live restart/recovery acceptance is recorded
   in `../TRANSCRIPT-WORKER-RECOVERY-ACCEPTANCE.md`.
4. The first adapter is a deterministic local/manual adapter. It accepts a
   bounded operator transcript fixture for local acceptance and never calls an
   external provider or requires credentials.
5. READY output contains a private transcript artifact and ordered timestamped
   segments. Public DTOs expose no storage key, credentials or raw provider
   payload.
6. A same-key replay returns the same intent; a same-key different request is a
   typed conflict. Stale context, wrong cut lineage, revoked source rights,
   malformed transcript and size limits fail closed without changing manual
   editorial revisions.
7. A large-slice acceptance test covers create, async delivery, replay, READY
   detail, segment ordering, private content checksum/range and manual ZIP
   checksum preservation.

Current checkpoint: PostgreSQL schema, immutable capture, idempotency registry,
lease/attempt state machine, versioned HTTP/OpenAPI routes, queue dispatch,
private GET/HEAD/Range delivery and worker recovery are implemented. A guarded
disposable PostgreSQL + private object-storage run proves READY, duplicate
delivery, expired-lease restart, stale-context object cleanup and controlled
retry exhaustion. Attempt-owned object keys, upload settlement markers and a
periodic durable cleanup reconciler protect ambiguous PUT/COMMIT outcomes.
Independent real-diff review completed CLEAN after architect approval.

Out of scope: external speech provider selection, automatic highlight
detection, factual research, text/image generation and Stage 3 publication.
