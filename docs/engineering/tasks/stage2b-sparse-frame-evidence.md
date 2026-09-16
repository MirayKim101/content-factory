# Stage 2B-2 — exact sparse-frame evidence

Date: 2026-09-16. Status: contract approved by independent architecture review;
implementation may start only inside the frozen decisions and acceptance gates
below. See `docs/engineering/SPARSE-FRAME-CONTRACT-REVIEW.md`.
Authority: project summary, both architecture documents, ADR-002, ADR-003, ADR-008,
MVP roadmap. Predecessor Stage 2B-1 is CLEAN (`d266ff8`).

## Observable result and scope

On a READY cut with a saved current creator/source-context/prompt chain, the
operator requests representative frames, sees background status and real
progress, reloads the page, then views three private timestamped images. Exact
cut/result/checksum and context revisions remain visible. An obsolete context
shows a reason and requires a new explicit request after the context is repaired.
Manual metadata, thumbnail, approval and ZIP remain independent.

This is deterministic sampling, not highlight detection. No transcript,
ai-worker, provider, research, generation, external call, new dependency or
publication is introduced. A successful frame set is not a complete transcript
plus frames evidence bundle. No automatic thumbnail selection or editorial
revision is created.

## Fixed versioned sampling contract

- Contract `editorial-sparse-frames-v1`; recipe `quartiles-jpeg-640-v1`.
- Exactly three requested positions relative to the immutable cut result:
  `floor(contractDurationMs / 4)`, `floor(contractDurationMs / 2)`,
  `floor(3 * contractDurationMs / 4)`, ordered by ordinal 0–2.
  `contractDurationMs` is the immutable exact cut segment `endMs - startMs`; it
  is not current project duration and is not invented from a rounded probe. The
  intent captures `startMs`, `endMs` and this duration. Admission rejects a cut
  longer than 10 minutes or a cut artifact larger than 512 MiB under v1; a new
  recipe version is required to change either ceiling.
- Positions must be distinct and strictly within `[0, contractDurationMs)`;
  unsupported tiny/invalid cut duration gives a controlled admission error. Do
  not silently change the recipe to a different number of frames.
- Extract from exact verified CUT_RESULT bytes using FFmpeg and the pinned MJPEG
  encoder profile. Scale with Lanczos to a maximum dimension of 640, preserve
  display aspect ratio, set square sample aspect ratio, and never upscale. Strip
  input metadata and omit audio, subtitle and data streams. The exact filter and
  output argv are recipe fixtures, not adapter defaults.
- Record requested cut/source-relative timestamp and actual decoded frame PTS
  separately. Never label requested seek time as a measured exact frame PTS.
  `quartiles-jpeg-640-v1` decodes from the beginning of the exact cut independently
  for each ordinal; input seek is forbidden. Before selection it applies
  `settb=AVTB,setpts=PTS-STARTPTS`, so the recipe time base is exactly
  `1/1_000_000`. It selects the first presented video frame satisfying integer
  `pts >= requestedMs * 1000`, with a one-shot predicate equivalent to
  `gte(pts,target)*isnan(prev_selected_t)`. The adapter must receive exactly one
  selected-frame timing record from the same FFmpeg process that writes that
  ordinal's JPEG. `-frames:v 1` alone is not proof of one selection.
- Persist `actualPtsTicks` and time-base numerator/denominator, plus the derived
  cut-relative display milliseconds. Source-relative actual time is explicitly a
  mapping `cutStartMs + actualCutOffset`; it is not claimed to be an original
  source-stream PTS. Actual ticks must be within the probed cut presentation and
  strictly increase across ordinals. Two targets resolving to one decoded frame,
  a missing frame, a second timing record, or unprovable timing is a controlled
  unsupported-media failure, not empty or duplicate success. CFR, VFR and
  non-zero stream-start fixtures must lock this behavior and the exact FFmpeg
  argv. The pinned worker image/FFmpeg version is extractor provenance; changing
  normalization, selection, scale or JPEG encoding requires a new recipe.
- Persist frame ordinal, JPEG type, dimensions, byte size, SHA-256, extractor
  and FFmpeg version. Hard ceilings are 4 MiB/frame and 12 MiB/set.

## Identity, admission and persistence

Add owned AI Content intent/result/frame/attempt-output persistence; preserve
existing MediaArtifact one-result uniqueness and all historical migrations.
An additive migration extends PipelineJob type with `EXTRACT_EDITORIAL_FRAMES`.
A dedicated `FRAME_EXTRACTION` capability applies current source authorization
and exact creator/context/prompt/cut lineage but no realistic-likeness gate.

The immutable intent captures project/source/version, source authorization
identity, exact cut job/artifact/SHA/bytes/duration/start/end, creator profile,
source-context and cut-prompt revision IDs/numbers, context fingerprint,
sampling contract/recipe and requested positions. The durable idempotency
ledger covers operation, path and explicit requested context/prompt revision.
Same key/same request returns the same intent; different body/path gives generic 409. Lost dispatch is recovered from PostgreSQL. A new explicit key may create
another intent; queue duplicates may never create a second result for one intent.

New HTTP admission requires both existing context flag and a separate
`EDITORIAL_FRAMES_ENABLED` flag, default off. Flag-off affects new requests;
manual work and historical metadata are unaffected. No FFmpeg in HTTP.

## Proposed frozen REST surface

All routes remain `/api/v1`, generated OpenAPI types, private deployment boundary.

- `POST /pipeline-jobs/{cutJobId}/frame-evidence` with Idempotency-Key and body
  containing exact `sourceContextRevisionId` and `cutPromptRevisionId` returns
  202 intent/job view. Backend resolves and captures all other identities.
- `GET /pipeline-jobs/{cutJobId}/frame-evidence?limit=&cursor=` returns a bounded
  descending list (default 20, max 50); cursor cannot cross cut/project scope.
- `GET /frame-evidence/{intentId}` returns immutable identity,
  `currentUse: { usableForGeneration, blockers, contextPolicyFingerprint }`,
  `contentAccess: { bytesReadable, blocker }`, job
  state/revision/attempt/nextAttemptAt/admissionReason, phase/progress and safe
  failure, plus ordered frame metadata after READY. `contentAccess.blocker` is
  null or `SOURCE_AUTHORIZATION_REQUIRED` in v1.
- `GET /frame-evidence/{intentId}/frames/{frameId}/content` and HEAD return
  private JPEG through existing owned streaming storage interface, supporting
  one byte range (200/206/416). Wrong intent/frame/project identity fails closed.
  No S3 object key or credentials appear in public DTOs.

Required job states reuse QUEUED/PROCESSING/RETRY_WAIT/READY/FAILED_FINAL.
Frame-specific progress schema `editorial-frame-progress-v1` reports
READ_INPUT/EXTRACT/HASH/UPLOAD/FINALIZE and completed frame count; basis points
are based on measured completed work, not wall-clock fabricated completion.
READY is committed only with all three immutable verified frames.

Historical list/detail metadata stays readable for audit after it passes exact
private intent/cut scope checks. It reports two separate decisions:
`usableForGeneration` with current context blockers, and `bytesReadable` with a
source-rights blocker. Metadata never exposes object keys.

Every frame content GET/HEAD rechecks the **current** authorization of the exact
captured `(projectId, sourceId, sourceVersion)` under the configured source policy.
Bytes are readable when that exact source version is currently `CLEARED`, even if
the creator profile, source-context or prompt has since advanced. Those context
changes make the set unusable for a new generation but do not erase private
historical inspection. Missing, non-current or non-cleared source authorization
fails closed with the existing typed `409 SOURCE_AUTHORIZATION_REQUIRED`; wrong
intent/frame/project identity remains `404`, and no storage read occurs. A future
re-authorization may restore private byte reading, but does not make the captured
context chain current or reusable for generation. This policy is also applied to
range and HEAD requests before storage access.

## Worker, concurrency and storage safety

Use existing independent media-worker and reference-only queue envelope. Add an
owned extractor port and adapter; API resolver internals are not imported into
worker application/domain. Worker-owned context validation adapter reads the
same authoritative policy via an explicit contract.

At admission, worker claim, immediately before the first cut-byte read, and
transactional finalization, revalidate exact current context and source rights.
Each gate is a serializable PostgreSQL transaction with bounded serialization
retry. The global lock order is resource-pool/slot rows `FOR UPDATE` when used;
owned intent/job/attempt/output rows `FOR UPDATE`; then exact `VideoSource`,
`SourceAuthorization`, cut `PipelineJob`, cut `MediaArtifact`, `CreatorProfile`,
`SourceEditorialContext` and `CutEditorialPrompt` current rows in that order
`FOR SHARE`. Admission has no slot/attempt to lock, but follows the same remaining
order. The gate then resolves the chain again through a transaction-aware adapter.
A resolver call made before or outside that transaction is only a hint and cannot
admit, read or finalize work. All upstream mutations of those current rows
serialize on the same rows; new advisory locks are not an alternative contract.

The pre-read transaction records `inputReadStartedAt`, exact policy fingerprint
and lease token with a CAS before releasing its locks. A mutation committed first
blocks the read. A mutation serialized after that marker cannot retract a read
already admitted, but it blocks retry/finalization and makes any earlier result
stale, matching the dispatch linearization in ADR-008. Finalization holds the
same current-row locks while it atomically accepts all frames and marks READY;
object I/O never occurs inside this transaction. Source/image inputs are never
read after a failed gate. Reference photographs are not inputs to this job.

A real bounded `FRAME_EXTRACTION` resource class is enforced across worker
replicas with PostgreSQL-owned durable slot rows, not process-local BullMQ
concurrency and not a long-held advisory lock. The local default is one configured
slot. In one transaction the worker locks one free slot, passes the claim gate,
creates the attempt, assigns the same lease identity to job and slot, and stores
an immutable absolute `workDeadlineAt`. Heartbeat renews the job and slot leases
or neither, but never extends this work deadline. Lease loss aborts FFmpeg and
prevents upload/finalization. Early release requires a lease-fenced
`executionStoppedAt` transition which makes the attempt unable to launch another
child and is written only after its whole process group has exited. Startup fails
closed when replicas disagree about configured slot capacity.
Occupied/configured counts come from this PostgreSQL pool.

Lease expiry alone never proves an old FFmpeg child exited and never permits slot
reuse. V1 gives frame work a finite absolute deadline (local default two hours)
and launches every FFmpeg child through the already-present OS `timeout` watchdog,
not only a Node event-loop timer. The watchdog receives the remaining absolute
budget, sends TERM at the deadline and KILL no later than 10 seconds later. An
expired slot is reclaimable only after either lease-fenced `executionStoppedAt`
is recorded, or PostgreSQL time is later than `workDeadlineAt` plus a 30-second
termination safety grace. A frozen/paused container consumes no running CPU; a
live partitioned owner is still bounded by the independent watchdog. Missing
watchdog capability fails worker startup.

Finite local scratch is reserved before the successful database claim and is
attached to that attempt during the claim transaction. Input reservation uses the
exact cut artifact bytes plus the 12 MiB output ceiling and a fixed safety margin.
No slot or scratch capacity returns the job to visible admission wait with a
bounded `nextAttemptAt`; it creates no `JobAttempt`, increments no attempt count
and consumes no retry budget. Durable reservation/lease recovery and worker
shutdown must prove the fenced execution-stop transition or the absolute watchdog
deadline plus grace before a slot is reused.

Each attempt owns one immutable output row and key per ordinal under
`ai-content/frame-evidence/{intentId}/attempts/{attemptNumber}/frames/{ordinal}`.
Before uploading any frame, persist its exact key and cleanup intent as PREPARED;
after upload, persist checksum/bytes/dimensions/timing as UPLOADED. Prepare,
upload and finalize must tolerate a process stopping at each boundary. One
`JobAttempt.outputObjectKey` is not sufficient for three images. Unique
`(attemptId, ordinal)` and object-key constraints are mandatory.

Finalization locks the intent, attempt and all three output rows. In one
transaction it creates the unique intent result and three immutable frame rows,
links each accepted frame to its attempt output, changes all winning outputs to
ACCEPTED/`NOT_REQUIRED`, and marks intent/job READY. It accepts all outputs or
none. Cleanup reservation uses a CAS that succeeds only for an unaccepted output
of an inactive/terminal attempt; it cannot race a winner. If cleanup wins the
lock first, that attempt cannot finalize. A new retry owns new keys; it never
overwrites or adopts an earlier attempt's objects.

After an ambiguous finalization response, first reread authoritative identity by
intent, attempt and accepted output IDs. A confirmed accepted result preserves
all winning objects. An unknown read outcome preserves every prepared/uploaded
key and its cleanup intent for later reconciliation. Only a confirmed losing,
inactive attempt may move its unaccepted outputs to PENDING cleanup. Cleanup
handles exact persisted owned keys, treats missing objects as idempotent success,
and never scans a prefix or bucket. Scratch cleanup likewise proves attempt
inactivity. No broad S3 bucket scans.

Storage permissions must be a narrow frames namespace, separate from creator
reference, source and manual editorial assets. Provision only restored runtime.

## Failure and retry contract

Safe typed errors: disabled admission, missing/non-READY/tampered cut, stale or
missing exact context/prompt, source rights denial, unsupported duration/size/media,
input/output checksum mismatch, missing frame, bounded output exceeded,
scratch/resource deferral, storage/FFmpeg failure and lease loss.

Transient storage failures retry within bounded existing job policy; stale,
rights, invalid media/contract and integrity failures finish controlled. Replays
and restart cannot extend retry budget or create duplicate accepted outputs.
Failed/partial results are never shown as READY. Explicit new request is offered
after terminal failure only when the current chain permits admission.

## Frontend after OpenAPI freeze

One owner adds a compact evidence feature and generated-client wrapper to the
existing horizontal cut workspace. No new player or global store. Vue Query
owns remote state; forms/route/retry storage use validated types. Display queued,
admission wait, active work, bounded retry and final failure distinctly. Poll
only active jobs; reload retains exact IDs and state. Render private images only
when their read policy permits it. Explain stale context and provide explicit
refresh/new request, preserving manual controls. New dialogs use the accepted
PrimeVue unstyled pass-through/layout conventions and viewport checks.

## Acceptance and rollout gates

1. Independent contract review in
   `docs/engineering/SPARSE-FRAME-CONTRACT-REVIEW.md` has resolved timestamp
   extraction, atomic currentness, resource admission, multi-output cleanup and
   stale read policy before code.
2. One backend/worker owner implements schema/contracts/ports/worker/API and
   focused tests; no concurrent schema, lockfile or shared contract edits.
3. Freeze generated OpenAPI before frontend implementation. No new dependencies.
4. Verify deterministic positions/real normalized PTS on CFR, VFR and non-zero
   start fixtures, three decodable JPEGs, dimensions, SHA/bytes, exact lineage,
   private GET/HEAD/206/416, and no full-bundle claim.
5. PostgreSQL integration proves same-key replay/conflict, concurrent duplicate
   delivery, partial upload cleanup, old-attempt rejection, ambiguous accepted
   and unknown finalization, stale queued/pre-extract/finalize, current rights,
   cross-scope reads, metadata-versus-byte read policy, scratch/slot deferral
   without attempt exhaustion, global slot exclusion across two worker replicas,
   stale-owner abort/grace and slot/lease heartbeat atomicity.
6. Real restored runtime proves reload/gallery, worker kill then lease recovery,
   one accepted frame set, temporary Redis delivery loss recovery, and unchanged
   manual approval/ZIP. Use disposable synthetic fixtures and scoped resources.
7. Relevant lint/typecheck/unit/integration/contract/build and browser acceptance,
   independent real-diff review, evidence, handoff and Notion update.

Migration rollback is admission-off with forward-compatible schema retained;
never delete frames/history or apply Mac migrations to legacy WSL data. Take a
verified scoped restored-database backup before runtime migration. Enable frame
admission only for controlled rollout after tests/review. Paid/external adapters
remain disabled. Protected Seanova/Seanova-new/DockerServer rules apply to every
command and all agents.
