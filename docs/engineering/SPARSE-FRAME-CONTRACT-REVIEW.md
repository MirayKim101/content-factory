# Sparse-frame contract review

Date: 2026-09-16. Reviewer: independent rollout reviewer. Verdict: **APPROVED
WITH THE FROZEN CLARIFICATIONS NOW INCORPORATED INTO THE TASK CONTRACT**.

## Scope and authority

This is a bounded architecture and contract review of
`docs/engineering/tasks/stage2b-sparse-frame-evidence.md`; it is not an
implementation review. The review used ADR-002, ADR-003 and ADR-008, both
architecture documents, the current Prisma model, AI context resolver and media
worker claim/finalization seams. It introduces no vendor, service, queue or
deployment-topology decision beyond the accepted ADRs, so no new ADR is needed.

## Decisions

1. **Historical metadata and private bytes have separate policy decisions.**
   Scoped list/detail metadata remains readable for audit. Frame GET/HEAD is
   allowed only while the exact captured source version is currently authorized.
   A later creator/context/prompt revision blocks generation reuse but does not
   hide bytes; a source-rights denial blocks bytes before object storage. The DTO
   must expose separate `usableForGeneration` and `bytesReadable` decisions.
2. **The v1 time domain is exact and reproducible.** Contract duration is the
   captured cut segment duration. Each ordinal is decoded from the beginning,
   timestamps are normalized to AVTB microseconds, integer PTS comparison selects
   the first presented frame at/after the target, and the same FFmpeg invocation
   supplies the selected timing record and JPEG. Requested time, normalized actual
   PTS and mapped source time remain distinct. Long/large inputs are controlled
   v1 rejections, and recipe behavior is locked by CFR/VFR/non-zero-start fixtures.
3. **Every decisive currentness check has a database linearization point.** A
   detached call to the existing resolver is insufficient. Admission, claim,
   pre-read marker and finalization use a transaction-aware resolver inside a
   serializable transaction and matching current-row locks. The pre-read CAS
   defines the same before/after semantics that ADR-008 defines for provider
   dispatch. No object I/O runs under those locks.
4. **Frame capacity is a durable global pool.** PostgreSQL slot rows carry the
   same lease identity as the claimed job/attempt. Claim and renewal are atomic.
   Lease expiry alone cannot reclaim a slot: reuse requires a fenced transition
   that prevents more children and records whole-process-group exit, or the
   immutable absolute work deadline plus an OS-watchdog kill interval and safety
   grace. BullMQ concurrency remains delivery coordination. Local scratch admission
   occurs before attempt consumption and becomes attempt-owned at claim.
5. **Cleanup is per output and winner-aware.** PREPARED rows exist before upload;
   all three outputs become accepted in the result transaction or none do.
   Finalization and cleanup reservation serialize on the same rows. An ambiguous
   or unreadable outcome preserves every exact key. Cleanup is restricted to a
   confirmed losing inactive attempt and never performs prefix scans.

## Compatibility with existing extension points

- `ResolveAiEditorialContext` currently resolves with independent reads. The new
  slice must add a transaction-aware gate path; it must not treat the existing
  query result as an atomic admission or finalization check.
- The current resolver already carries exact source authorization, cut artifact,
  prompt, source-context, creator-profile and policy fingerprint identities. The
  new capability and intent can extend that read model without duplicating the
  policy in an HTTP controller.
- `CutSegment.startMs/endMs` supplies the immutable v1 contract duration. The
  existing AI cut-lineage read model does not expose it, so the owned lineage port
  must be extended and the artifact must still be revalidated by ID/SHA/bytes.
- Current worker claim locks a job and creates one `JobAttempt`; current
  `JobAttempt.outputObjectKey` and cleanup state cover one output. The frame path
  therefore needs the reviewed per-attempt output rows and the specialized atomic
  slot/claim gate. Retrofitting three keys into the single field is rejected.
- Existing reference-only queue messages, PostgreSQL job leases, heartbeat,
  scratch reservations, exact object storage reads and Range streaming are valid
  seams. The new frame namespace and narrow storage permission remain additive.

## Required evidence before delivery can be called CLEAN

- PostgreSQL concurrency tests must force upstream mutation at every gate, two
  simultaneous deliveries, two worker replicas competing for one slot, lost
  heartbeat, denial of reuse on lease expiry alone, watchdog deadline/grace and
  finalization-versus-cleanup races.
- Worker fixtures must include CFR, VFR and non-zero stream start, record requested
  time and actual rational PTS, and prove three strictly increasing selected
  frames. The observed prototype where a 750 ms request selected the 760 ms frame
  is expected contract behavior, not permission to copy requested time to actual.
- Crash-point tests cover PREPARED-before-upload, each partial upload, ambiguous
  accepted result, unknown reread, losing cleanup and a winning result protected
  from cleanup.
- API tests separately prove historical metadata visibility, generation staleness,
  current source-rights denial before storage, private scope, HEAD and single-range
  200/206/416 behavior.
- Restored-runtime smoke remains scoped and disabled by rollback flags until a
  verified database backup, migration review and independent real-diff review.

No unresolved architecture finding remains in the approved task contract.
