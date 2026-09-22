# Stage 2B-3 transcript foundation review

Status: bounded local/manual foundation, 2026-09-22.

This slice freezes the provider-neutral transcript boundary in
`packages/contracts/src/transcript.ts` and adds a deterministic local adapter
under `apps/api/src/ai-content/transcript/`. The adapter accepts a bounded
operator JSON fixture, validates non-overlapping ordered segments within the
exact cut duration, serializes a private JSON artifact and records its SHA-256.
It makes no network calls, uses no provider SDK and requires no credentials.

`LocalTranscriptService` preserves the required asynchronous shape: creating an
intent stores `QUEUED` state and delivery is a separate operation. The in-memory
repository is a deterministic acceptance double for this first bounded slice;
it is not the PostgreSQL implementation or the ai-worker queue. The existing
manual editorial and ZIP path remains independent.

Focused coverage in `apps/api/test/transcript-local-adapter.spec.ts` proves
same-key replay, typed conflict for a changed request, ordered READY segments,
artifact checksum/size equality, idempotent delivery and fail-closed malformed
fixtures.

Remaining integration work before calling Stage 2B-3 accepted: additive Prisma
intent/attempt/artifact/segment persistence, versioned HTTP/OpenAPI routes,
private object-storage range reads, an independently runnable ai-worker queue,
and a live acceptance run that also verifies manual ZIP checksum preservation.
