# Worker shared-filesystem capacity — Slice 2

Status: source and native verification independently reviewed, 2026-10-14;
functional PASS, security DENY. This document does not approve production promotion.

## Problem reproduced in source

The admitted media process constructs `ProcessMediaJob`, `ProcessFrameJob` and
`LocalSourceCache`. Their current admission counters are independent. Directory
names do not identify independent disks, so concurrent operations may each
authorize writes against the same available blocks. Conversely, a cut currently
asks the cache to reserve its future output against the cache directory even
though FFmpeg writes that output under the scratch directory. A successful
cache-device check therefore cannot establish scratch-device capacity.

The cache initializer removes the contents of its configured root. Equal or
ancestor/descendant cache and scratch roots can therefore erase unrelated
worker markers or attempt directories. This configuration is rejected at
startup, before either cleanup or reconciliation. Architect review approved
separate fill/output ownership and a required static cache output target.

Scratch capability preflight in the preceding slice checks usability only.
It intentionally does not resolve these capacity-admission defects.

## Implemented bindings

`main.ts` constructs one `LocalFilesystemCapacityLedger` after private-root
preflight and before repositories, queue admission or reconciliation. Cache
and scratch each register their actual filesystem identity and the existing
configured safety reserve; shared-device admission applies the maximum once.
The required `LocalSourceCache.outputTarget` is the same scratch target passed
to media and frame processing. No cache-side default can stand in for it.

Each cache hit or single-flight waiter reserves its own output before joining.
Only the fill owner holds source bytes. Consumer cancellation releases its
output target, not the shared fill; fill bytes release after the real writer
and partial-file cleanup settle. In-flight publication remains protected from
eviction until waiting readers pin their handles. Shutdown waits for admission
and fills, then reports remaining local reservations as a failure rather than
silently freeing another consumer's budget.

Media assembly/export retain their existing preclaim `INSUFFICIENT_SCRATCH`
deferral. Recovered export reservations replace their conservative ledger
entry atomically. Cuts and probes keep their existing output estimates;
`MONTAGE_ASSET_PROBE` still requests zero output bytes. Frame local holds omit
safety because the existing PostgreSQL claim already includes it; local
refusal calls that claim with zero available bytes, never `rejectPending`.
Durable claims, lease fencing and inactivity-gated cleanup are unchanged.

The frozen candidate `1ec8b5cb938f01edc5f7c6c56759e7ddd78c01d8` passed
393 tests in 50 files, strict TypeScript, zero-warning lint and build after the
stale-sample correction. It also moves commit-specific runtime image metadata
after the independent pinned OS layers, preserving pins, inventory checks and
source-stage provenance verification. Docker's documented ARG cache semantics:
<https://docs.docker.com/reference/dockerfile/#impact-on-build-caching>.
The final explicit-PNG candidate
`0c9cf33c347eb373a801abc2d6cd9e16b09b54d3` independently repeated all 393 tests,
plain zero-warning lint, strict types and build. The reviewer compared 137
fixture files with LF/CRLF normalization and all 95 image-context files
byte-for-byte. No source findings remain. Final native and recovery checks pass
as recorded below; independent native reproduction is complete. Earlier
366-test/19-container evidence does not prove this new slice.

## Final pinned native artifact, 2026-10-14

The exact 95-file context from `0c9cf33` was built with
`BUILDX_GIT_INFO=0 --provenance=mode=max --no-cache-filter runtime`, using its
own Dockerfile. The cold FFmpeg install executed with the explicit PNG pin;
the later five-package transaction retained its exact inventory assertions.
No package manifest or lockfile changed.

- Local tag: `content-factory-worker:capacity-proof-0c9cf33`.
- OCI archive: `tmp/worker-capacity-native-GGLAT7/worker-png-linux-amd64.oci.tar`.
- Archive SHA-256:
  `2a2f639613c279fcbe541defd2ed8788595ae23e996970e3bdc0309b78c6d42f`.
- Index: `sha256:02b61ed61830eb45018ebe126d3acd545a9b28f6beb0079634540c67c7e9e866`.
- AMD64 manifest: `sha256:298dbaa02d5aee718ff54f80d1dacf4ae8086dac0e466db3d70ff731bb7ef1bc`.
- Config: `sha256:7fa69b4a87d67056d8a79628182607689ce6bec7fb1ee5b4382da2f8f7b0d11d`.
- Attestation: `sha256:d6ef4433351d780cad878f1f926e97bbdab85a3b687adffd35439df86812d687`.

Full comparison against `content-factory-worker:scratch-proof-5349e0b`
retains exactly 288 OS package names. Only PCRE2 `u1 -> u2` and PNG `u5 -> u6`
change; the remaining 286 versions, all 66 Node packages, FFmpeg/ffprobe
binaries and font checksum match. `inventory-png-proof.json` SHA-256:
`0a673d3d7906332035aea13c0e137bff1425cb2e0e0cca76055b1e173837e3fa`.

All 24 native startup/capacity cases pass with non-root/read-only/cap-dropped,
network-disabled containers. They include every role's unusable-root refusal,
private-root/owner/mode/symlink/marker failures, three root-overlap cases,
actual same-device cache contention and split-device atomic refusal.
`startup-png-proof.json` SHA-256:
`ccdf99981182ea9345b795bf0b3e13e725871be16015da4b932ee5f0f9ce8b79`.

A separate one-second native PNG encode/decode/overlay and output decode pass.
Decoded overlay pixels are red `(252,0,0)` while pixels outside remain blue
`(0,0,254)`; H.264 output is 320x180, exactly one second. This is pipeline
compatibility coverage, not a claim to exercise the library's CVE code path.
`png-overlay-proof.json` SHA-256:
`bf0a1e4b96a8c0b80cfe4fbdd142e63cb627cb73b7dfa82bf8248a76075f29f9`.

The combined real API/PG/BullMQ/MinIO media batch uses only disposable project
`cf-worker-capacity-20261014`, no host ports or provider credentials:

1. Manual upload/authorization, probe, cut, exact request replay and downloaded
   checksum pass; exactly one persisted artifact per logical cut is checked.
2. Graceful worker stop exits zero. A queued job remains PostgreSQL-owned while
   the fixture's Redis DB 0 is cleared (17 keys to zero), then recovers at
   attempt 1 after startup.
3. A PROCESSING job is killed with SIGKILL (exit 137), restarts under attempt 2
   and produces the expected 26744-byte checksum
   `9d2b0d60955535065e20f8dae6326a89118d9f8226c095fce3e7ad03ca7a5e6e`.
4. Corrupted encoded samples fail as `FFMPEG_CUT_FAILED`, without a result.

The first harness run mistakenly selected empty Redis DB 12 and stopped at
its nonempty-key assertion **before any flush**. `final-media-run.log` retains
that failure. After read-only keyspace/queue-prefix verification, the harness
resumed the exact existing queued project in DB 0; it did not replace jobs or
waive a failed application check. `final-media-proof.json` records this resume,
all actual IDs, attempts and hashes; SHA-256:
`c1c327d83d4386bb98192202f94a0b15858665e52f722399e3a28d69cd4232d2`.

Fresh offline all-severity scan of this exact attested OCI completed using the
verified October 14 DB, schema 2 and age below 24 hours. It **denies promotion**
at 754 non-LOW records. Evidence: `tmp/artifact-scan-H0EADV`.
SHA-256: SBOM `dcdf7eb6f135b710f1bda438267962292f79a78c45f6718a5c5e6c3c891b90ad`,
report `73e1a5fa77c6d34953586651b8da5bce61ad9d047cc5b78d579808be73df4aca`,
evidence `42c51e024aaf8341305644f4c0a3aa3f11faa8c129f826176524b927ed9fc4ee`.
Functional acceptance and the exact inventory do not override this denial.

Independent final review found no new correctness defects. The reviewer
re-executed all 24 startup cases, complete inventory and PNG pixel tests using
the immutable image index, and separately validated all OCI/provenance/source
and scanner bindings. Main's media/recovery scripts, failed harness log,
resumed run and JSON evidence were inspected; that recovery sequence was not
independently replayed while the edge integration used the live fixture.
Review: `/tmp/cf-worker-final-review-20261014-bU26cb/HANDOFF.md`.
Independent startup/inventory/PNG JSON SHA-256 respectively:
`f5b56db9b931137f6b9703cffd61ba92e8249bc45ad87d0a0fd2e852103b845c`,
`8b26df0d5b2922ecb1854555dac1c140cda701267b2838b2e8ebf13e9dc8839b`,
`6092b43bee9c2e5e80cf07bd6339b8e1136e2c00d6c6535f254af4bce0d2570f`.

## Binding architect scope

This is an ordinary correction within ADR-011, not a new persistent-storage,
disk-only or distributed-capacity architecture. One admitted process shares
one filesystem-device coordinator across every enabled media/frame/cache
component. Existing PostgreSQL claims, durable attempt reservations, leases,
cleanup evidence, retry classification and assembly/export
`INSUFFICIENT_SCRATCH` deferral remain authoritative and are not removed.

Every reservation identifies its actual output domain:

- Cache fill: source bytes on the cache device, once per single-flight fill.
- Cut output: output estimate on the scratch device for every source handle,
  including hits and each single-flight waiter.
- Frame input/output and assembly/export work: scratch device.

Admission for cache and scratch is atomic. Different devices must both pass
under the same coordinator lock before either reservation is committed. The
same device coalesces requested bytes and applies the safety reserve once.
Sampling `statfs(cacheDirectory)` cannot authorize scratch output.

Independent review reproduced a stale-sample race: a fill could retain its
completed physical file and release its future-write hold while another
admission awaited the last filesystem reading. Pairing that old reading with
the new smaller ledger could over-admit. The coordinator now records a mutation
generation before sampling and refuses admission (or returns zero to the
existing frame claim) if any reservation changes before sampling completes.
Three deterministic regressions cover fill release, recovered-reservation
replacement and frame availability. This is a refusal/retry, not a busy loop
or a terminal failure.

Physical bytes already present are reflected in available filesystem blocks;
an additional ledger entry represents admitted future writes, not a second
cache-size counter. Existing conservative recovered scratch reservations
remain fail-closed, even when recovery plus physical bytes temporarily
double-count. Removing that accounting requires separate exact-ownership and
remaining-byte evidence; it is not part of this slice.

Reservations release exactly once after the associated I/O has settled.
Aborted fills must settle their actual download and partial-file cleanup;
consumer cancellation must not release another waiter's reservation. Cache
hits and read-only references must not reserve the cached source again.
The cache's own configured size/eviction policy remains distinct from physical
filesystem admission.

## Large-slice acceptance

1. Whole worker formatting/lint, strict types, complete unit batch and build,
   from a frozen source snapshot rather than protected pending API files.
2. Cross-component contention: media, frames and cache sharing one device
   cannot collectively over-admit. Distinct directory paths on one device are
   tested explicitly.
3. Split-device atomic refusal, same-device coalescing, malformed filesystem
   readings and device-identity mismatch fail closed without partial holds.
4. Cache-hit output refusal uses scratch-device availability; fill owners and
   each waiter retain their own output budget, but source fill is single-flight.
5. Failure, abort, lost claim, successful completion and repeated cleanup all
   demonstrate exact-once release after real I/O settlement, without detached
   writers. Existing recovered reservations still block conservatively.
6. PostgreSQL frame claims retain persisted cross-worker reservations and
   inactivity-gated cleanup. Existing assembly/export admission reasons and
   retry behavior remain compatible.
7. Exact-Git native image plus one combined upload/cut/replay, queue-loss,
   SIGKILL/recovery/duplicate-prevention and controlled-failure batch.
8. Actual all-severity artifact scan and independent real-diff/reproduced
   verification before commit/push. A successful functional batch never turns
   a denied security gate green.

## Unresolved production boundaries

A process-local ledger does not coordinate another process, container,
replica or unrelated writer on the same filesystem. Production requires one
writer process per recorded capacity domain, enforced isolation/quotas, or a
separately approved host-aware coordinator. Different Docker volume names are
not evidence of separate physical capacity.

Existing cut output reservation is an estimate derived from source size, not
an enforced maximum output size. This slice does not change FFmpeg recipe v3,
certify peak-media workloads, establish physical quotas or invent deployment
disk/safety budgets. Storage selection, retention, backup/restore, final
artifact advisories and credentialed provider acceptance remain separate gates.

## Rollback boundary

Keep a v3-capable worker and switch new admission off before replacing it.
Drain or recover admitted jobs using existing durable evidence. Do not discard
PostgreSQL reservations, delete another process's scratch, reset user Redis,
or alter media recipes to make capacity tests pass.
