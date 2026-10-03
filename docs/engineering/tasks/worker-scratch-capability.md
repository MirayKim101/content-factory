# Worker scratch capability and readiness boundary

Status: large-slice source and native runtime verification passed; independent
review CLEAN on 2026-10-04. Production release remains blocked.

Architect decision: 2026-10-03, ordinary correction within ADR-011. This is
not a persistent-storage, disk-only or distributed-capacity decision.

## Behavior and boundary

Every admitted worker role checks its readiness/scratch root before external
repositories, queues and timers are created. Media also checks its source-cache
root. Rollback verification uses the same probe without creating or removing
a readiness marker. Startup catches only the dedicated capability error and
returns exit 78 with the generic `CONFIG_SCRATCH_UNUSABLE` event; other failures
keep their existing classification.

The configured root must be an absolute normalized real directory, private
`0700`, owned by the non-root effective runtime UID. Parent ownership need not
match: `/` and `/tmp` may remain root-owned. Missing segments are created one
at a time with private mode and revalidated. Existing broad/nonprivate roots
are rejected, never silently chmodded. Protected path segments are rejected
before filesystem calls; ancestor symlinks are not followed or resolved.
This does not establish the origin of a host bind mount; effective mount review
must separately exclude protected host directories.

An unpredictable exclusive/no-follow `0600` probe performs write, fsync, full
readback, close and exact-file unlink. Failure cleans only the owned probe;
there is no recursive cleanup. BigInt filesystem statistics are checked for
internal validity, not against a new free-space threshold. Bounded diagnostic
tmpfs remains valid; physical capacity and persistence are not inferred.

Readiness cleanup ignores only `ENOENT`. Other errors refuse startup. During
shutdown a failed removal is logged without paths and retains non-zero exit
status, while queues and clients still receive their normal close sequence.

## Acceptance slice

1. Worker lint, strict types, complete unit batch and native build.
2. Pure injected-I/O faults: path/identity/mode/owner, symlinks and creation
   races, malformed statistics, exclusive flags, write/fsync/read failures,
   exact cleanup ownership and bounded cleanup retries.
3. Real private-directory and stale-marker-directory cases.
4. Exact-Git final image startup: unusable scratch/cache, nonprivate/wrong-owner
   and read-only mounts refuse startup; bounded private tmpfs succeeds.
5. Direct Node and normal entrypoint failures are generic, fast and happen
   before network/queue initialization. Selected non-media roles do not inspect
   the unused media cache. Rollback does not change readiness.
6. Combined media upload/cut/replay, queue loss, SIGKILL recovery, duplicate
   prevention and corrupt-media failure remain accepted.
7. Actual all-severity artifact scan remains separate and fail-closed.
8. Independent real-diff and reproduced-evidence review before commit/push.

## Recorded large-slice verification

Source candidate `5349e0b5a941db9c77a67fd95bf3192ba02e4dcd`, tree
`4be95c66df5449cdb38e821b12835a220d24a37b`, contains only the seven owned
worker/task paths on top of checkpoint `85a4c02`. The isolated source gate at
`/tmp/cf-worker-scratch-full-CyloO5` uses committed API baseline files for
integration-test imports, never protected pending API files. Worker lint,
strict TypeScript, all 366 tests in 49 files and native build passed together.
An earlier gate exposed a test literal-type error and missing closed-snapshot
API imports; both were corrected before the accepted full batch. Prisma
generation additionally needed the explicit inert fixture configuration.

The exact exporter selected 94 files at `tmp/worker-context-t83UlH`. Native
linux/amd64 image `content-factory-worker:scratch-proof-5349e0b` was loaded and
exported with maximum provenance to
`tmp/worker-scratch-native-QfpRPD/worker-linux-amd64.oci.tar`:

- Archive SHA-256:
  `d02daa72ba4465fed81c4f1d5a7b45425bb8f69f8bacce3f96ed8a84950d5807`.
- Leaf:
  `21b0267a791f92dd9b4bbf1122cc592d570c9cb8f328bf4dcc6a70c304bb5599`.
- Config:
  `43545a5571dcbc378a4ba122cd12826addbc29bfcc05f8e4d574930907fb2cce`.

An initial build command omitted the required `SOURCE_REVISION` argument and
was correctly refused by provenance validation. The corrected command supplied
the exact source candidate; there was no provenance bypass.

All 19 native startup cases passed, using non-root/read-only/no-network
containers, bounded private tmpfs and inert credentials. The five role failures
were reproduced through both normal entrypoint and direct Node execution.
The publication master switch was enabled only in a no-network negative case
that failed before repository/queue initialization; provider switches stayed
off. Other cases cover wrong owner, nonprivate mode, read-only mount, unusable
media cache, unused non-media cache, ancestor symlink, marker directory and
rollback marker preservation. A valid private bounded tmpfs passes preflight;
the deliberately disabled vertical role retains its existing error instead
of being reclassified as a scratch error.
`tmp/worker-scratch-native-QfpRPD/startup-proof.json` SHA-256:
`60466d1f3d73794ecb2de2065b572140101e0761d1fd838032b2d3facde618ca`.

The disposable `cf-api-proof-20261003` namespace passed the combined media
batch with the exact candidate worker: upload/cut/replay, loss of its own Redis
queue, restart, SIGKILL after observing PROCESSING, lease expiry/retry and
corrupt-video controlled failure. Result checksums stayed identical, terminal
outputs remained singular, the interrupted job completed on attempt two and
the worker healthcheck passed after recovery. Project:
`d7ef4c8b-978f-4ad4-a341-381981b7a5ff`; normal job:
`bdf4aedf-e609-4240-8116-b72a20f7d169`; queue-loss job:
`e1c4d282-1a73-44c0-8656-2bb15eb12864`; interrupted job:
`3a2d3ecb-0d59-4ffb-a2d1-76c9cf49fe58`.
`tmp/worker-scratch-native-QfpRPD/media-evidence.json` SHA-256:
`94e89c220b822aefc07ab3e372c03f2cb1d873cd272a384e064dc1cb740b5383`.
Only the previous owned ephemeral proof file was removed after checking its
SHA-256; its host copy remains retained. User development services were not
used for destructive diagnostic checks.

Actual all-severity Trivy/Syft evidence at `tmp/artifact-scan-ORmL1N` remains
**DENY: 695 non-LOW records**, with `promotionApproved=false`. SBOM SHA-256:
`19bf588a664a21637f97f2f6f65abac9e408d116aee305a2aa4243f45e7a94f7`;
report SHA-256:
`6bed19181119c352b9ee41d5f5e46bbb3ae6a495620b0c529842263ff0654c27`.
No exception, reduced severity gate or production eligibility is inferred.

Independent reviewer inspected the real candidate diff and all three Main-owned
documents, reproduced formatting/lint/strict types/all 366 worker tests/build,
and independently repeated all 19 native startup cases. Independent startup
evidence: `/tmp/cf-worker-startup-review-20261004-f2SoqC/startup-proof.json`,
SHA-256 `b50247664ba0e22a8f0d8afb134ae754e35febce8d7187be57ceeb15bbddff6c`.
Recorded OCI/startup/media/scanner hashes matched the retained evidence, and
read-only inspection confirmed the exact running worker revision without
published ports. Outcome: CLEAN, no actionable findings; no reviewer edits.

## Not solved by this slice

Per-component media/frame/cache reservations are still not unified. Neither
this probe nor a later process-local ledger coordinates another process,
container, replica or unrelated writer on the same underlying filesystem.
Production needs recorded mount/quota/replica facts and a measured admission
budget. Separate directory names or Docker volumes do not prove separate
capacity. Source/build audits and final artifact findings still block release.

## Rollback

Use the prior immutable v3-capable worker after quiescing owned jobs; no schema,
recipe or media-object migration is involved. Do not chmod an arbitrary path
to make preflight pass. Supply a reviewed dedicated private writable root with
correct UID and bounds. Disabling capability checks or lowering security gates
is not a rollback option.
