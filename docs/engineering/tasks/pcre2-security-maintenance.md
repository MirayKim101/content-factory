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

## Continuation after checkpoint `993524e`

The preceding PCRE/PNG/capacity/diagnostic-edge checkpoint was committed and
pushed as `993524e533a5fe1db966f797fa8bf88c8de4c274`; the remote branch SHA
was checked. The separately approved Perl transaction is now implemented in
both Dockerfiles but has not yet passed its new native/inventory/scan gate.
It preserves the original five-package assertions and changes no linked-media
version. A new combined source candidate will include the lockfile owner's
compatible security resolutions before the next large verification batch.

Main also approved these ordinary same-major compatible resolutions after
checking official package metadata, published versions and advisories:

- `source-map-js 1.2.1 -> 1.2.2`; locked parent `magicast@0.5.4` declares
  `^1.2.1`. [Advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
- `postcss-selector-parser 7.1.5 -> 7.1.6`; locked `postcss-calc@10.1.1`
  declares `^7.0.0`. [Advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
- `shell-quote 1.10.0 -> 1.11.0`; locked `launch-editor@2.14.1` declares
  `^1.8.4`. [Advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv).

Together with proxy-addr these are four specific resolutions, not permission
to refresh the whole graph. One owner controls `pnpm-lock.yaml`; manifests and
existing overrides remain unchanged. All actual parent constraints and the
complete generated delta must pass review. Simple-git/argv-parser major
replacement is outside this slice; unpatched advisories stay blocked. No
resulting audit reduction or artifact acceptance is claimed before the new
cold install, large API/web checks, native scenarios and scans run.

### Worker Perl diagnostic artifact — partial new-slice verification

Frozen worker candidate `5cd916a3599a707da2b2d1bd254f857050f6fb88`, tree
`5b50bd2f7fad903b0c9033f35f6a5c706127bdde`, includes only the new worker
Dockerfile transaction above parent checkpoint `993524e`. The worker source,
tests, contracts and lockfile are byte-identical through Git to the preceding
393-test candidate; the pending API/web lockfile resolutions are not in this
worker-only artifact and are not claimed as verified by it.

The exact 95-file context `tmp/worker-context-7KfjEG` built with max provenance
and automatic Git metadata disabled. Previously verified FFmpeg/PNG and
five-package parent layers were reused unchanged; the new Perl transaction
executed cold and asserted its full before/after delta. Build log:
`tmp/security-maintenance-20261014-0MOH8w/worker-perl-build.log`.

- Image: `content-factory-worker:capacity-proof-5cd916a`.
- OCI SHA-256: `11f26ed7d85ac0dd67a72178b1488daf9ecbe9ab46abd51e547f59fac136eb1f`.
- Index: `sha256:ba2babfe8d2978c323bee741a6df36a8c5d155e0a98417de05861d5a5993e91c`.
- AMD64 manifest: `sha256:855c09008706ae327d59e6873da8cf7de0d1f82bab5ca3a28431b388986a39b2`.
- Config: `sha256:c73ad23583bbc072d5edba017a2362d287d0f04be7692853d494e3612cda6d16`.
- Attestation: `sha256:cf41e10c560528dafe9b82477dfd8b7682fe94ff87f62216a59f5b5bfd87b534`.

All 24 native startup/capacity tests and decoded PNG-overlay pixels pass.
Complete inventory comparison against immutable `0c9cf33` retains 288 OS names,
66 JS versions and the FFmpeg/ffprobe/font hashes; only perl-base changes
`u3 -> u4`. Inventory proof SHA-256:
`9f30d5c8803d95a16a83e4302698bda76ed6bc79b3af3c46c848edc51d0b19e2`.
Startup/PNG proof SHA-256 respectively:
`0d21b4297649dbef1d3940afc0afc5a22c5e8c2fb4e409227ab9f4b0080a863e`,
`a2f9459a4713e24991ecf0e9bcbd7c4da2f774e0c60073a3ff1764c5d1c2b90f`.

Fresh scan on the same verified October 14 DB completed in
`tmp/artifact-scan-MvFgly`: **DENY 741 non-LOW records**, versus 754 in the
preceding artifact on that same DB. This measured 13-record reduction is not
a clean gate or a percentage of production readiness. Evidence SHA-256:
`4bc29ebf3f0c19d2702f95cea1ee9e8f96d8a7c2385943c5be007cca5215090d`.
New combined API/migration/media recovery, independent review and remaining
slice checks are still pending. No registry promotion or deployment occurred.

### Final uniform combined candidate — supersedes partial evidence above

Frozen source `e17b10c5449c0b72b248fc68e6bb9e32fb3b8f75`, tree
`a6f5f6eb5715ed7ffec5bba1cbd38266190ab577`, binds all four diagnostic images.
The earlier worker-only `5cd916a` record remains historical and is not relabelled.
Both full and production-classified source audits now deny six advisories
(two critical, four high), versus ten before the four compatible resolutions.
Cold strict installation downloaded 934 packages, reused zero. API 324 tests /
65 files, lint/types/build and both OpenAPI gates pass. All 16 actual parent
constraints were reviewed; manifests, overrides and lifecycle permissions did
not change. Source proof `tmp/proxy-addr-maintenance-tVEsVG/final-proof.json`,
SHA256 `8ac3854d5121790cc35767d58ae9d56c6e764ad9ab7fd5afe7aa35c0d57e6e92`.

Native OCI indexes and actual non-LOW scan records:

| Artifact | Immutable index SHA256                                             | Scan decision |
| -------- | ------------------------------------------------------------------ | ------------- |
| API      | `276a867355666d81b8b789613fdddef713682c119be8c9ba08e940e9c3f9b42c` | DENY 145      |
| Migrate  | `c153e773cc0b193c4b50ea451ab60429c02fca6b47adca17336d8d4663f116d1` | DENY 155      |
| Worker   | `94036362ac801a71d593d7dd7c68d56cab63b1fdf2af802a8301d2ef3b5f212b` | DENY 741      |
| Web edge | `b06fbe244ba4fe9421998c692a9f47a727de61ee3c4a9a17940083d43f09b8fd` | DENY 19       |

API/migrate retain 88/90 OS names and change only Perl from their preceding
native checkpoint; API's 180 JS packages change only proxy-addr, migrate's
135 JS packages remain identical. Worker retains 288 OS names/66 JS packages,
FFmpeg/ffprobe/font hashes; only Perl changes. All 24 actual startup/capacity
cases and decoded PNG-overlay pixels pass, independently reproduced.
Same verified fresh scanner DB SHA256
`88daf0f4f0789698811bec5ebf95ef9610cd0f4d0571394f754a5cdb8cf081c9`;
all severities retained, no ignore-unfixed/allowlist/threshold waiver.

New isolated runtime `cf-security-e17-20261014` uses only these API/migrate/
worker images. Fresh/repeat 45 canonical migrations, queue-disabled API smoke,
queue-enabled upload/manual source rights/probe/cut/idempotent replay, Redis
queue loss (attempt 1), SIGKILL 137 recovery (attempt 2), checksum/Range,
413/415 and corrupt-media controlled failure/cleanup all pass. Proof:
`tmp/security-maintenance-20261014-0MOH8w/combined-runtime-proof.json`, SHA256
`beacfe48dc3e3acc3c890822daa32e8148d30c290aaf0dfd9e87e60b52c22142`.
Disruptive recovery scripts/logs were independently inspected, not rerun by
the reviewer. Inventories/startup/PNG were independently rerun. Source/native
review handoffs are `/tmp/cf-maintenance-independent-20261014-TJ6YNa/HANDOFF.md`
and `/tmp/cf-uniform-e17-review-20261014-aniuyE/HANDOFF.md`.

Final web proof `tmp/web-edge-final-e17-Er5Uq6/final-combined-evidence.json`
SHA256 `9a27094d57915b6753fd7bfea74818572d1783447215ebebb04c64e49c66548d`
includes 278 tests/51 files, static build, real API/media through new edge,
256 MiB transfer and 65-second stream. Strong read-only browser checks cover
16 desktop/mobile cases and eight comboboxes. Two native preload cancellations
retain raw FAIL with narrowly tested classification; no blanket error waiver.
Independent full web gate/browser/recovered-output rerun is CLEAN in bounded
scope: `/tmp/cf-strong-ui-review-20261014-XjTq76/HANDOFF.md`.
Manual montage upload remains blocked by its separate rights protocol gap;
browser write acceptance is not claimed. All security decisions remain DENY.
This is a verified diagnostic checkpoint, not production promotion/deployment.
