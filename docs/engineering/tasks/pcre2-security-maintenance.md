# Bounded Bookworm PCRE2 security maintenance

Status: architect-approved implementation/diagnostic verification, 2026-10-14.
Independent source/native review found no new correctness defects. Final worker,
API and migrate artifacts were scanned and all deny promotion. The worker's
24 startup/inventory/PNG checks were independently repeated; Main's full media
recovery evidence was inspected, not independently replayed. See the linked
component task records. Production promotion/deployment remain blocked.

## Evidence and decision

Native worker candidate `1ec8b5cb938f01edc5f7c6c56759e7ddd78c01d8` failed
closed because official repositories no longer provide the pinned PCRE2
`10.42-1+deb12u1`. The build did not silently select another version.

The [official Debian package](https://packages.debian.org/bookworm/amd64/libpcre2-8-0)
and [DLA-4816-1](https://security-tracker.debian.org/tracker/DLA-4816-1)
identify `10.42-1+deb12u2` as the Bookworm security successor. The downloaded
official amd64 package is 261628 bytes with SHA-256
`d2f7edfcc7689b9e0761c2742cc824ac86a20768bc5e8057818dc6875291fe76`.
Its embedded Debian changelog dated 2026-10-03 records a backported JIT-stack
allocation fix for CVE-2026-103111; the dependency remains `libc6 >= 2.34`.
Evidence: `tmp/worker-capacity-native-GGLAT7/pcre-official-package-review.log`.

The Content Factory architect classified this as ordinary bounded maintenance
within ADR-011, not a new OS/FFmpeg baseline or new ADR. Only the exact install
pin and matching `dpkg-query` assertion change in `apps/worker/Dockerfile`
and the shared API/migration `infrastructure/api/Dockerfile`.

All four other reviewed OS pins, Node/Bookworm digest, FFmpeg 5.1.9, font,
application graph, topology, default-off gates, scan policy and exact
five-package inventory checks remain unchanged. This is not an advisory
exception, an unpinned install or permission to deploy.

## Explicit worker PNG scope extension

A same-source cold build additionally selected a newer existing FFmpeg
dependency: `libpng16-16=1.6.39-2+deb12u6` instead of the preceding `u5`.
The initial full inventory comparison correctly refused this unapproved
difference; it was not silently added to an allowlist.

On 2026-10-14 the architect separately approved an explicit bounded extension:
pin that existing library in the initial FFmpeg installation and assert its
exact version. Preserve the later five-package transaction unchanged. PNG is
not added to API/migration images. Final worker inventory must retain all 288
package names and 286 other versions, with only PCRE2 and PNG changing from
the preceding `5349e0b` image. Expat/OpenSSL downgrades observed in an earlier
warm-cache image remain rejected.

[Debian DLA-4824-1](https://security-tracker.debian.org/tracker/DLA-4824-1)
and the [source-package tracker](https://security-tracker.debian.org/tracker/source-package/libpng1.6)
identify `u6` as fixing CVE-2026-46675. The official amd64 package is 277048 bytes,
SHA-256 `940b91d40d51c825de7f7aa133aecff1ffa25a91f12cb6aa6926c9ad55cd640c`.
Its embedded changelog dated 2026-10-05 records the `png_read_end()`
use-after-free fix; libc/zlib dependencies remain unchanged. Evidence:
`tmp/worker-capacity-native-GGLAT7/png-official-package-review.log`.

This requires a new exact-source artifact, native/recovery tests, PNG
decode/overlay coverage, full inventory and fresh scans, plus independent
review. The earlier unpinned image's functional checks are not acceptance of
the forthcoming pinned image. Other FFmpeg transitive dependencies remain
unlocked; a complete lock or reviewed repository snapshot is a separate task.
Full final-inventory comparison must continue rejecting unapproved drift.

## Required evidence before delivery

1. Rebuild exact-Git worker, API runtime and migration artifacts.
2. Compare each complete package inventory with its preceding immutable image:
   no additions/removals or changes outside the explicit reviewed scope above;
   require PCRE2 exactly `10.42-1+deb12u2`. Investigate any cold-build transitive
   drift rather than accepting it implicitly.
3. Repeat native manual pipeline, failures, duplicate prevention and restart/
   Redis-loss recovery; preserve all application and media lineage.
4. Bind fresh SBOM, provenance and complete all-severity scans to the actual
   image digests. Findings other than exact LOW still deny promotion.
5. Independent reviewer reproduces checks and inspects the real diff/inventory.

## Rollback

Discard unaccepted diagnostic artifacts and retain the preceding immutable
evidence. Do not present the superseded `u1` image as production-safe merely to
restore buildability. No database migration, persisted state or object lineage
changes are introduced. Source advisories and deployment prerequisites remain
independent mandatory gates.

## Approved next slice, not implemented in this checkpoint

On October 14 the architect approved two separate compatible maintenance
changes only after the current explicit-PNG checkpoint is recorded:

- Existing `perl-base` only: `5.36.0-7+deb12u3 -> 5.36.0-7+deb12u4`, in worker
  and shared API bases, inherited by migrate. Use a separate full before/after
  inventory transaction with zero additions/removals and only this version
  changing. Preserve the original five-package checks, PNG assertion and
  migration-only OpenSSL checks. Any companion-package change exceeds scope.
- Existing compatible Express dependency resolution: `proxy-addr 2.0.7 ->
2.0.8` through the reproducible pnpm lockfile, without overrides or unrelated
  upgrades. Recheck official release/package evidence before installation.

Main separately rechecked the official [Perl package](https://packages.debian.org/bookworm/amd64/perl-base),
[proxy-addr 2.0.8 release](https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8)
and [Express 5.2.1 dependency manifest](https://raw.githubusercontent.com/expressjs/express/v5.2.1/package.json)
before starting any later installation. The proxy release identifies
CVE-2026-90711; its compatibility remains bounded by the existing dependency
range, not a major override.

Acceptance requires cold affected OS layers, frozen installs, exact source and
final-inventory comparisons against this completed checkpoint, applicable
large source/integration gates, forwarding/address regressions, API upload/
Range/readiness, migration replay, worker recovery/duplicate/failure evidence,
new provenance/SBOM/fresh scans and independent reproduced review. Predicted
finding reductions are not results. Neither change approves production or
waives any remaining finding.

A different Bookworm/Node/FFmpeg baseline, replacement EOL dependency major,
self-built Caddy binary or alternative edge requires a material ADR decision.
Before proposing one, reconcile vendor advisory status and compare maintained
alternatives, exact closure, codec/font/recipe compatibility, resources,
support horizon, recovery, cost and rollback. Missing `FixedVersion` alone is
not evidence that no fix exists anywhere. No alternative baseline is approved.
