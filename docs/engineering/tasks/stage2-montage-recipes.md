# Stage 2b — immutable horizontal assembly recipe

Status: approved for implementation after Stage 2a UI acceptance
Owner: Backend Engineer — Montage Recipe
Architecture: ADR-005; no additional ADR is required inside this boundary

## Outcome

A READY horizontal cut can store and reload an exact, immutable assembly recipe
that selects an intro, outro, one advertisement, banner intervals, and one CTA.
This slice persists configuration only. It does not enqueue FFmpeg or create an
output object.

## Durable model

- `AssemblyRecipe`: one aggregate per exact READY `CUT_SEGMENT` job, with the
  project, exact READY cut-result artifact snapshot, source lineage, cut-local
  duration, and current revision.
- `AssemblyRecipeRevision`: append-only `(recipeId, revision)`, schema version
  `horizontal-assembly-v1`, deterministic configuration fingerprint, and
  server-owned profile versions `youtube-stereo-v1` / `youtube-h264-v1`.
- `AssemblyRecipeAssetReference`: normalized immutable references for each
  revision. Store role, ordinal, asset id, revision, checksum, size, kind, and
  duration snapshots. Do not expose an object key.
- `AssemblyRecipeMutationRequest`: unique idempotency key, request fingerprint,
  and resulting revision. CAS and revision creation are one PostgreSQL
  transaction.

Metadata revisions remain independent in `EditorialPackage`. A later approval
will bind an exact editorial revision, exact assembly revision, and exact
rendered artifact.

## REST v1 contract

- `PUT /api/v1/pipeline-jobs/:jobId/assembly-recipe` with `Idempotency-Key`.
  First save uses `expectedRevision: 0`; later saves use current revision N.
- `GET /api/v1/pipeline-jobs/:jobId/assembly-recipe` returns current revision,
  exact cut snapshot, and validation state.
- `GET /api/v1/pipeline-jobs/:jobId/assembly-recipe/revisions/:revision`
  returns an immutable historical revision.
- `GET /api/v1/projects/:projectId/assembly-recipes?cursor=&limit=` supports
  reload without per-card N+1 requests.

Request body:

```json
{
  "expectedRevision": 0,
  "introAssetId": null,
  "outroAssetId": null,
  "advertisement": { "assetId": "uuid", "insertAtMs": 900000 },
  "banners": [
    {
      "clientItemId": "banner-1",
      "assetId": "uuid",
      "startMs": 30000,
      "endMs": 45000,
      "position": "TOP_RIGHT"
    }
  ],
  "cta": {
    "text": "Смотрите стрим на Twitch",
    "startMs": 60000,
    "endMs": 75000,
    "position": "BOTTOM_LEFT"
  },
  "audioProfileVersion": "youtube-stereo-v1",
  "encodingProfileVersion": "youtube-h264-v1"
}
```

The API uses integer milliseconds. Desktop UI displays and accepts `HH:MM:SS`
without milliseconds while retaining exact integers internally. Limits: one
intro, one outro, one advertisement, up to eight banner intervals, one CTA,
CTA text length 1–120. No raw FFmpeg arguments or codec knobs.

## Invariants

1. The target job is exact `CUT_SEGMENT/READY` with exact
   `CUT_RESULT/READY`; project, source/version, checksum, and authorization
   lineage must match.
2. Every referenced montage asset is READY, belongs to the same project and
   exact source/version, and has the expected kind. It must also pass the
   current policy-aware project/source-version gate and have usable
   asset-scoped rights evidence. Missing, partial, tampered, or
   `LOCAL_DEVELOPMENT_AUTO` evidence under manual policy fails closed, as do
   pending, failed, wrong-kind, and cross-project references, without creating
   a revision.
3. For cut-local duration `D`: advertisement satisfies `0 < t < D`; overlay
   intervals satisfy `0 <= start < end <= D`; banner `clientItemId` values are
   unique.
4. Timeline semantics are `intro -> cut[0,t) -> ad -> cut[t,D) -> outro`.
   Banner and CTA apply only to the cut timeline, pause during an advertisement,
   and never shift because of intro/ad/outro duration.
5. Same idempotency key and canonical request replays the same revision. The
   same key with another request is 409. A stale expected revision is 409.
6. Historical revisions remain immutable and retrievable. Saving a recipe does
   not mutate cut results, montage assets, or editorial packages and creates no
   pipeline job or storage object.

## Acceptance

1. Save and reload intro, outro, advertisement, two banner intervals, and CTA
   for a READY cut; the response is identical after process restart/reload.
2. Edit N to N+1; N remains retrievable and unchanged. Stale CAS is 409.
   Concurrent same-key replay creates one revision; changed-body replay is 409.
3. Wrong project/source version/kind, non-READY asset/cut, tampered lineage,
   missing or tampered asset rights evidence, local-auto evidence after a
   switch to manual policy, and invalid or overflowing times fail closed with
   zero partial writes.
4. Exact cut/asset checksums, revisions, sizes, and profile versions survive a
   full reload. Object keys and raw metadata text are absent from public DTOs
   and structured logs.
5. Existing source, cut, thumbnail, editorial, and montage tests remain green;
   tests prove that recipe save creates no FFmpeg job or object.
6. OpenAPI generation/drift, unit tests, isolated PostgreSQL race/integration
   tests, lint, typecheck, format, and build pass, followed by independent
   real-diff review.
7. After contract freeze, desktop PrimeVue UI exposes an obvious recipe action
   on each READY cut, READY/correct-kind selectors, `HH:MM:SS` controls, visible
   validation, save/reload, and stale-conflict handling. Mobile is out of scope.

## Next render handoff

The next slice will persist an `AssemblyRenderIntent` and an
`ASSEMBLE_HORIZONTAL` job transactionally. The worker must read one exact
recipe revision and all captured cut/asset snapshots from PostgreSQL; it must
never resolve `currentRevision`. Duplicate delivery, lease loss, restart, and
Redis loss must converge on one logical immutable result with full lineage.

## Explicitly out of scope

Render, preview, export, approval, audio analysis, arbitrary filter graphs,
multiple advertisements, animated banners, transitions, deletion/replacement,
cross-project assets or presets, AI, Twitch, vertical clips, and publishing.

## Rollback

Hide recipe routes and UI and stop accepting new recipe mutations. Keep the
additive tables, historical recipe revisions, and all MontageAssets so rollback
does not destroy lineage or user data. No worker or queue drain is required
because this slice creates no jobs. Existing source, cut, editorial, and
montage-asset flows continue unchanged. Physical deletion requires a separate,
explicit cleanup procedure.
