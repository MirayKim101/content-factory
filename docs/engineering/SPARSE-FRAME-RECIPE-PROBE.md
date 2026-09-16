# Sparse-frame recipe feasibility probe

Date: 2026-09-16. Scope: independent pre-implementation feasibility evidence.
Verdict: **FEASIBLE** on the pinned restored media-worker. This is not product,
repository, slot/lease, storage or worker acceptance.

## Environment and harness

The exact container was checked before execution:

```text
content-factory-restored|media-worker|running|healthy
ffmpeg version 5.1.9-0+deb12u1
/usr/bin/ffmpeg
/usr/bin/ffprobe
/usr/bin/timeout
```

No package was installed and no service, database, queue, policy or runtime
configuration was changed. Disposable files were limited to:

- host harness: `tmp/frame-contract-review/run-recipe-probe.sh` and
  `tmp/frame-contract-review/verify.py`;
- host evidence: `tmp/frame-contract-review/evidence-run1/`;
- supplemental anamorphic harness/evidence:
  `tmp/frame-contract-review/run-anamorphic-probe.sh` and
  `tmp/frame-contract-review/evidence-anamorphic/`;
- container scratch:
  `/tmp/content-factory-frame-contract-review-20260916`.

The main harness generated synthetic three-second MPEG-4 CFR, sparse VFR and
non-zero-start inputs. Each of three requested positions was decoded independently
from the beginning. The tested filter normalized timestamps with
`settb=AVTB,setpts=PTS-STARTPTS`, selected once with
`gte(pts,target)*isnan(prev_selected_t)`, scaled with Lanczos, set square SAR and
placed `showinfo` after scale in the same FFmpeg process that wrote one JPEG.

## PTS and JPEG correlation

The verifier compared each logged normalized PTS to the first decoded frame at or
after the requested position from an independent `ffprobe -show_frames` list. It
also required exactly one selected-frame `showinfo` record, AVTB `1/1_000_000`,
one non-empty JPEG, matching SHA-256, strictly increasing PTS and the expected
dimensions/SAR.

| Fixture        | Input timing                  | Requested ms | Actual normalized PTS ms | JPEG output      |
| -------------- | ----------------------------- | ------------ | ------------------------ | ---------------- |
| CFR            | 25 fps, start 0               | 750          | 760                      | 640×240, SAR 1:1 |
| CFR            | 25 fps, start 0               | 1500         | 1520                     | 640×240, SAR 1:1 |
| CFR            | 25 fps, start 0               | 2250         | 2280                     | 640×240, SAR 1:1 |
| VFR            | frames spaced 300 ms, start 0 | 750          | 900                      | 320×240, SAR 1:1 |
| VFR            | frames spaced 300 ms, start 0 | 1500         | 1500                     | 320×240, SAR 1:1 |
| VFR            | frames spaced 300 ms, start 0 | 2250         | 2400                     | 320×240, SAR 1:1 |
| Non-zero start | 25 fps, stream start 2000 ms  | 750          | 760                      | 640×360, SAR 1:1 |
| Non-zero start | 25 fps, stream start 2000 ms  | 1500         | 1520                     | 640×360, SAR 1:1 |
| Non-zero start | 25 fps, stream start 2000 ms  | 2250         | 2280                     | 640×360, SAR 1:1 |

All nine checks passed. Eight results deliberately differ from the requested
position; the VFR 1500 ms target legitimately lands on a frame at exactly 1500 ms.
The verifier derives actual time from `showinfo` and the decoded frame list, never
from the request. Full hashes and byte sizes are recorded in
`evidence-run1/verification-summary.json`.

The complete generation/extraction harness was then repeated in the same pinned
container. All nine JPEG SHA-256 values matched the first run exactly; the two
ordered hash lists are `tmp/frame-contract-review/run1-hashes.txt` and
`tmp/frame-contract-review/run2-hashes.txt`.

The CFR input was 960×360 and reduced to 640×240. The VFR input was 320×240 and
was not upscaled. The non-zero-start input was 854×480 and reduced to 640×360.
Every output remained MJPEG `yuvj420p`, maximum dimension 640 and SAR 1:1.

## Display aspect ratio correction

A supplemental 720×576 input with SAR 16:15 and display aspect 4:3 proved that
scaling coded `iw/ih` and then forcing SAR 1:1 would be incorrect. The feasible
policy computes a single no-upscale factor in display space, using display width
`iw * sar`, then emits even square-pixel dimensions. It produced 640×480, SAR 1:1,
display aspect 4:3 and actual normalized PTS 760 ms for a 750 ms request. The
implementation must lock this display-space expression in its exact argv fixture.

## Independent watchdog behavior

The existing `/usr/bin/timeout` was exercised outside the Node event loop:

- a live FFmpeg process received TERM, logged `received signal 15`, ended in one
  second, and `timeout` returned 124;
- a child that ignored TERM received KILL after the one-second kill-after window,
  ended in two seconds, and returned 137.

This proves the pinned image can enforce TERM/KILL independently. Product evidence
must still prove that the worker passes the remaining immutable five-minute
absolute budget, uses a process group, records the fenced execution-stop outcome,
and does not reclaim the database slot from lease expiry alone.

## Limits of this probe

- The fixtures are synthetic and do not cover every codec, corrupt media, rotation
  metadata, interlacing or extreme dimensions.
- The VFR fixture's final presentation duration is 2.733 seconds; all three tested
  targets are within its decoded presentation. Delivery acceptance still needs a
  full contract-duration VFR fixture and the controlled missing-frame case.
- This probe runs the proposed command shape directly. It does not verify the
  implementation adapter's parser, byte ceilings, error mapping, retries,
  PostgreSQL gates, global slots, cleanup or API DTOs.
- Deterministic selection is proven for the pinned FFmpeg build and recorded
  recipe. Cross-version JPEG byte identity is not claimed; FFmpeg/extractor
  versions and output SHA remain artifact provenance.

No recipe feasibility blocker remains. The anamorphic display-space correction is
mandatory for implementation acceptance.
