# Transcript foundation checkpoint

The Stage 2B-3 foundation is now frozen as a provider-neutral local/manual
adapter contract. `packages/contracts/src/transcript.ts` defines immutable
input capture, ordered bounded segments, artifact checksum and adapter
provenance without exposing provider payloads.

`LocalManualTranscriptAdapter` accepts a bounded operator-supplied fixture and
produces the same normalized artifact shape expected from a future
`TranscriptionProvider`. `LocalTranscriptService` demonstrates durable-service
semantics against an explicit repository port: same-key replay returns the same
intent and delivery is idempotent. No network, credentials or external provider
are used.

This is the foundation checkpoint, not full Stage 2B-3 acceptance. The next
vertical step must connect the port to additive PostgreSQL intent/segment rows,
an independently runnable ai-worker queue, private object storage and the
REST/OpenAPI plus UI flow. Manual editorial save/approval/export remains
independent throughout.
