# Pre-Twitch MVP execution plan

This is the bounded delivery sequence for Stage 2B before Twitch. Protected
directories and their services remain outside every step.

## 1. Transcript runtime hardening

- [x] Persist immutable transcript intent lineage.
- [x] Serve private transcript bytes with GET, HEAD, Range, ETag and cache policy.
- [x] Run transcript processing in the isolated `ai-worker` queue.
- [x] Fence lease, deadline, latest attempt, source authorization and current
      context/profile/prompt revisions before READY.
- [x] Reproduce a real disposable database READY/expired-lease/restart smoke.

Evidence: `TRANSCRIPT-WORKER-RECOVERY-ACCEPTANCE.md`.

Acceptance: one valid intent yields one authoritative artifact; stale or
replaced attempts cannot finalize or leave an intent stuck in PROCESSING.

## 2. Research and editable text

- [x] Define cited provider-neutral contract and local deterministic adapter.
- [x] Publish REST response in OpenAPI and add typed web client.
- [ ] Link a transcript intent to the editorial dialog.
- [ ] Persist research snapshot and editable suggestion revision.
- [ ] Apply a suggestion through the existing optimistic editorial save path.
- [ ] Invalidate approval when an applied revision changes.

Acceptance: manual metadata remains usable; a cited suggestion can be reviewed,
edited, applied, and traced to its snapshot without inventing external claims.

## 3. Thumbnail candidates

- [x] Define provider-neutral candidate metadata and provenance contract.
- [ ] Add local candidate adapter with manual fallback and controlled failure.
- [ ] Persist candidate lineage and private content delivery.
- [ ] Add candidate list, preview, select and apply actions in the dialog.
- [ ] Require reference authorization for likeness mode.

Acceptance: manual, AI-assisted and mixed thumbnail modes remain selectable and
their provenance is visible in the package revision.

## 4. Unified approval and export gate

- [ ] Revalidate current metadata, thumbnail, transcript/frame lineage and rights
      at approval time.
- [ ] Invalidate approval after every edit or regeneration.
- [ ] Export the exact approved revision and manifest.
- [ ] Record processing time, manual attention and local/provider cost fields.
- [ ] Run one restored end-to-end smoke with controlled failure evidence.

Acceptance: a package can be completed manually or with AI assistance, and the
ZIP/export always refers to the exact approved revision.

## 5. Delivery discipline

Every slice gets a focused test, typecheck/lint, OpenAPI check when applicable,
runtime evidence, a commit, and a handoff update. Twitch ingestion, publishing,
analytics and vertical clipping start only after this checklist is accepted.
