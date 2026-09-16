# Restored manual Stage 2 synthetic smoke

Date: 2026-09-16

Scope: the isolated `content-factory-restored` runtime only. No user media,
external asset, provider, legacy database, legacy object storage, or AI feature
was used.

## Runtime and rollout state

- PostgreSQL, Redis, MinIO and the media worker run in the distinct restored
  network/volumes described in
  [restored-runtime.md](../infrastructure/restored-runtime.md).
- `ASSEMBLY_RENDER_ENABLED=1`, `EDITORIAL_APPROVAL_ENABLED=1` and
  `EDITORIAL_EXPORT_ENABLED=1` were enabled only in the local isolated `.env`
  for this owner-authorized manual smoke. `AI_CONTEXT_ENABLED=0` remains set.
- The worker started healthy with `SOURCE_PROBE`, `CUT_SEGMENT`,
  `MONTAGE_ASSET_PROBE`, `ASSEMBLE_HORIZONTAL` and
  `EXPORT_EDITORIAL_PACKAGE` capabilities.

## Happy path evidence

The starting synthetic six-second source and its READY cut are documented in
`tmp/restored-runtime/stage2/evidence.json`; the cut interval is 1000–4000 ms.

| Step                       | Result                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Manual processing template | immutable revision 1 created                                                                                                              |
| Manual thumbnail           | private synthetic PNG, `1280×720`, SHA-256 `dafbd38ed484f44f8ebe37095b110b759cf3f379e0d836730b0e7e8ccec3e30f`                             |
| Reusable montage assets    | one READY synthetic 1-second H.264/AAC advertisement and one READY PNG banner                                                             |
| Assembly recipe            | revision 1 with a 1500 ms advertisement insertion, banner and cut-local CTA                                                               |
| Background assembly        | READY 320×180 H.264/AAC MP4, expected/actual duration 4000 ms, SHA-256 `e9c32e9b6df0338a7d59ef12a440ed6decb851c6b76300952e7606d71bc458f8` |
| Exact review and approval  | review was approvable with no blockers; current revision-2 approval recorded                                                              |
| Background export          | READY ZIP64 export SHA-256 `14cb7a16d87687f917545e4eb99af6f1d62218590ab080b9d27a0b4c5f25e34a`                                             |

The current ZIP was downloaded through the same-origin Nuxt dev proxy. Python's
standard ZIP reader verified its CRC and exact root entries:

```text
video.mp4
thumbnail.png
metadata.txt
metadata.json
manifest.json
```

The manifest contains the four payload entry checksums, exact revision 2,
recipe revision 1, approval ID and `horizontal-render-v1` lineage.

## Controlled invalidation and recovery

The first exact approval was deliberately invalidated by a new manual metadata
revision. It became `STALE` with `EDITORIAL_REVISION_CHANGED`; attempting an
export returned HTTP `409 EDITORIAL_APPROVAL_STALE`. No old package was
overwritten. A fresh review, current approval and second export then succeeded,
leaving the runtime in a usable current state.

## Reproduction

Run the existing-current-result verifier while the restored API/UI are running:

```sh
sh tmp/restored-runtime/stage2/verify-current-export.sh
```

It downloads the current package via `http://127.0.0.1:3000/api/v1`, validates
the exact five archive entries and CRC, the exact approval/export/revision/
recipe/render IDs and contract versions, and each payload's manifest size and
SHA-256 against its ZIP entry. It then prints the archive SHA-256. The script
contains no credential and touches only the ignored
`tmp/restored-runtime/stage2` directory.

This is runtime evidence, not an independent acceptance of Stage 2B UI or a
production rollout. The independent review required by the project operating
model remains separate.

## Independent verification and browser evidence

Independent review: **CLEAN**, 2026-09-16. The reviewer reran the hardened ZIP
verifier, independently checked rendered MP4 codec/duration/checksum, and
reproduced stale-approval HTTP 409 with unchanged operation/export counts.

The orchestrator also opened the horizontal workspace in Chromium, opened the
manual editorial dialog (separate metadata and thumbnail `MANUAL` badges), and
downloaded the current ZIP using the visible UI link. No JavaScript errors were
observed. Evidence: `tmp/recovery/restored-manual-browser.json`,
`restored-manual-editorial.png`, and `restored-browser-export.zip`.
