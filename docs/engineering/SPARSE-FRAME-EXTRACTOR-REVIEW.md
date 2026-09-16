# Sparse-frame extractor checkpoint review

Date: 2026-09-16. Scope: independent review of the Stage 2B-2 contract helpers,
worker extractor port, FFmpeg adapter and focused extractor tests. Verdict:
**CLEAN for this isolated extractor checkpoint**.

This verdict is not integrated Stage 2B-2 acceptance. It does not cover the
schema migration, API, transactional currentness gates, global resource slots,
attempt-output cleanup, queue recovery, storage policy application or frontend.

## Reviewed surfaces

- `packages/contracts/src/frame-evidence.ts` and its package export;
- `apps/worker/src/application/frame-extractor.port.ts`;
- `apps/worker/src/infrastructure/ffmpeg-frame-extractor.ts`;
- `apps/worker/test/ffmpeg-frame-extractor.spec.ts`;
- `apps/worker/test/fixtures/frame-extractor-harness.ts`.

The review compared the real diff with the frozen recipe and
`SPARSE-FRAME-RECIPE-PROBE.md`; it did not rely on the implementation report.

## Findings resolved during review

1. Lease-loss abort and diagnostic overflow were initially classified after exit
   137/deadline handling. A TERM-resistant lease-loss child could therefore appear
   as a work timeout. Final ordering preserves spawn failure, abort reason and
   overflow before interpreting an actual watchdog deadline. An early process
   exit 137 is now a media failure unless time has reached the deadline.
2. Initial output validation trusted JPEG boundary bytes and pre-encode `showinfo`
   dimensions. The adapter now probes the encoded object, requires MJPEG, exact
   dimensions and SAR 1:1, and performs a strict decode with `-xerror -err_detect
explode` before hashing and accepting it.
3. Extractor provenance initially reused the evidence contract string. The final
   contract records distinct `ffmpeg-frame-extractor-v1`, recipe and FFmpeg build
   values.
4. The initial display-space geometry floored both dimensions and produced
   640×358 for the 854×480 fixture. Nearest-even geometry now produces 640×360,
   while the anamorphic 720×576 SAR 16:15 fixture remains 640×480 SAR 1:1.
5. Merely repeating the geometry formula could accept severe distortion. A pinned
   10×4 SAR 1:2 input demonstrated 5:4 becoming 1:1. The final validator has an
   independent one-percent relative display-aspect bound and returns controlled
   `FRAME_TIMING_UNSUPPORTED` for this case.
6. Startup capability verification now rejects an unsupported FFmpeg version;
   each subprocess remains behind the independent OS watchdog and immutable
   attempt deadline.

## Independent reproduction

Focused checks on the frozen extractor files passed:

```text
pnpm --dir apps/worker exec vitest run test/ffmpeg-frame-extractor.spec.ts
Test Files 1 passed; Tests 12 passed

pnpm --dir apps/worker typecheck
PASS
```

The actual adapter harness was independently copied into the label-verified
`content-factory-restored|media-worker|running|healthy` container and run with its
pinned FFmpeg 5.1.9 package. It produced and strictly decoded 12 JPEGs across CFR,
VFR, non-zero-start and anamorphic inputs, then rejected the tiny distorted-aspect
fixture:

```json
{ "passed": 4, "decodedJpegs": 12, "tinyAspectRejected": true }
```

The reproduced evidence is
`tmp/frame-contract-review/adapter-rereview-v2-evidence.json`. Its SHA-256 is
`2462befbce262317f7468a4df084e5cba0fa3a42d030cba71d2575e432266ad0`, exactly
matching `tmp/frame-implementation/adapter-evidence.json`.

## Remaining acceptance boundary

The extractor proves deterministic positions, actual normalized PTS, pinned
encoding geometry, encoded JPEG validity and bounded child termination in
isolation. Delivery remains incomplete until the later independent review proves
database linearization, slot fencing/deadline recovery, all-or-none multi-output
acceptance, ambiguous-outcome preservation, current-rights content gates and the
restored-runtime end-to-end scenario.

No unresolved finding remains in the reviewed extractor checkpoint.
