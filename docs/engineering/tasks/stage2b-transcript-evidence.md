# Stage 2B-3 — transcript evidence and local AI-worker foundation

Status: foundation checkpoint; REST/worker wiring pending

This slice adds a provider-neutral transcript evidence boundary after the
accepted sparse-frame slice. It keeps the existing manual editorial path
available when no transcript adapter is configured.

## Acceptance criteria

1. An exact READY cut can create one idempotent transcript intent bound to the
   current creator profile, source context and cut prompt revisions.
2. PostgreSQL owns the intent, immutable input capture, attempt state, segment
   metadata, checksums, adapter version and controlled terminal failure.
3. Transcript work is delivered asynchronously to an independently runnable
   `ai-worker` queue. HTTP never performs transcription.
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

Out of scope: external speech provider selection, automatic highlight
detection, factual research, text/image generation and Stage 3 publication.
