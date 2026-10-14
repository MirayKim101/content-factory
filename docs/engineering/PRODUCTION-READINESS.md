# Production readiness — evidence, not a percentage

Updated: 2026-10-14. Current status: **production release blocked**.
Local product acceptance, container preparation and actual external operation
are separate milestones. No real publishing/provider admission is authorized
by a green local test.

## What is established

| Area                       | Evidence and boundary                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual horizontal pipeline | Upload, explicit rights, independent background cuts, assembly/editorial packaging and private download have local acceptance.                                                                                |
| UI/UX                      | Common styled selectors, responsive workspaces, clear capability/admission states and desktop/mobile checks are recorded in the handoff.                                                                      |
| Stage 3 control planes     | Twitch, vertical and publication behavior has local/unit/integration acceptance; real provider canaries remain separate. See `STAGE3-LOCAL-ACCEPTANCE.md`.                                                    |
| Source quality             | Large immutable-source slice: lint, strict types, 919 unit tests, OpenAPI consistency and all workspace builds passed.                                                                                        |
| Actual cut API             | Eight PostgreSQL/BullMQ/MinIO integration tests passed against fresh isolated dependencies, including legacy replay and controlled failures.                                                                  |
| Minimal API/migrate        | Frozen exact-Git contexts, native Node runtime, non-root/read-only isolation, fresh/repeat 45 migrations, readiness and upload/download smoke passed.                                                         |
| Minimal media worker       | Native Node, exact production dependency closure, versioned thread-bounded v3 cuts, queue-loss and SIGKILL recovery, checksum and duplicate prevention passed. This does not certify every other worker role. |
| Paired recovery            | A tiny non-versioned diagnostic dump and its 12 MP4 objects restored with all 74 tables/checksums matching. Missing input failed before PUT. Not a production backup service or RPO/RTO.                      |

Exact candidate identities, test scopes, evidence paths and rollback are in
`CURRENT-HANDOFF.md` and the linked task records. Protected pending API files
are not part of these deliveries; their committed Git baseline is used only
where ADR-011 explicitly permits it.

The subsequent worker scratch-capability slice separately passed its full
366-test worker batch, strict types/build, 19 actual native startup cases and
the combined media/recovery/failure scenario. It rejects unusable roots before
queue/network initialization and makes readiness-cleanup failures visible;
see `tasks/worker-scratch-capability.md`. Independent review is CLEAN. This
does not establish shared-filesystem admission, replica quotas or persistent
production scratch. Its actual full artifact scan remains DENY at 695 records.

## Mandatory unfinished gates

The 2026-10-14 continuation is still under verification, not a production
approval. API upload admission passed an independently reproduced 312-test
batch; worker shared-device admission passed 393 tests including a reproduced
and corrected stale-filesystem-sample race. The final PNG-pinned worker passed
24 native startup/capacity cases, full inventory/PNG overlay and real media/
queue-loss/SIGKILL/failure checks. Independent native review reproduced startup,
inventory and PNG checks, and inspected (not replayed) the media recovery proof.
See `tasks/api-upload-capacity.md`,
`tasks/worker-shared-capacity.md` and `tasks/pcre2-security-maintenance.md`.

1. **Security of source/build and final artifacts.** Complete and production-
   classified dependency audits were repeated on October 14 with the unchanged
   lockfile: each exits 1 with ten advisories (4 critical, 5 high, 1 moderate).
   The two historical unpatched high advisories remain:
   [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and
   [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), with no published
   patched version in the recorded audit. Additional findings affect
   proxy-addr, source-map-js, postcss-selector-parser, shell-quote, simple-git
   and its argv-parser; the audit's patched-version field is not permission
   for an unsupported major override. Complete JSON evidence is retained in
   `tmp/worker-capacity-native-GGLAT7/source-audit-{full,production}-20261014.json`.
   Full/production report SHA-256 respectively:
   `664732b1dae3ab242e314445fb62b62ab9126631ad05c74573fd0eb0066ed5d7`,
   `4a2ae98a9cbb6e4e7e0fe239a34358acc0ee8f5a1aae9703070687708ed1f7a9`.
   Fresh 2026-10-14 hardened API/migrate
   artifact scans deny promotion at 159/168 non-LOW records. Those counts are
   not unique CVEs or a percentage of readiness. The preceding hardened worker scan denies
   promotion at 695 non-LOW records after five bounded OS updates, down from
   717 after global-manager removal and its original 743-record baseline; native
   dependencies and media/recovery behavior are unchanged. See
   `tasks/worker-runtime-hardening.md`. The web-edge scan is a separate gate.
   The final explicit PNG-pinned `0c9cf33` worker scan with the newer database
   denies at 754 non-LOW; functional checks do not waive this denial.
   Counts across database dates are not directly comparable. No allowlist,
   `ignore-unfixed`, severity reduction
   or final-image-only substitution for the source gate is allowed.
2. **Static web-edge runtime.** ADR-011 specifies static Nuxt SPA assets in a
   pinned Caddy image, with the fixed streaming `/api/v1` route. Exact-Git
   static generation, strict web types and 13 preparation/runtime helper tests
   passed; see `tasks/web-edge-runtime.md`. Official `caddy:2.11.7-alpine` is
   now published and the pinned native image passed 256 MiB upload/download,
   65-second streams, cache/deep links and controlled upstream failures.
   Its actual all-severity scan denies promotion at 19 non-LOW. Independent
   diagnostic review is CLEAN. Initial browser hydration/geometry smoke passed
   on 12 desktop/mobile pages and eight selectors, but settled loading,
   late responses and keyboard-close acceptance are being strengthened.
   Actual API/media-through-edge upload/authorization/cut/replay/Range/failure
   and recovered downloads passed; independent final evidence review remains
   pending, independently of dev UI on port 3100. Initial screenshot review
   also identified duplicate selector focus outlines and mobile-specific copy
   to polish; the initial render smoke is not full operator acceptance.
3. **Production storage and operations.** Select and verify persistent disk
   capacity, bounded non-RAM media scratch, cleanup/retention, encrypted
   off-host backups, all-writer fencing and realistic paired restore drills.
   The tiny diagnostic tmpfs is explicitly not a large-media deployment.
4. **Private deployment prerequisites.** Actual server, private access model,
   domain/TLS ownership where applicable, secret storage/rotation and operational
   responsibility need recorded decisions. Preparation must not invent these
   facts or configure public access. Default external write switches stay off.
5. **Credentialed provider acceptance.** Twitch ingestion and every enabled
   AI/publishing provider/channel require approved credentials and a bounded
   canary. Confirm remote identity, approved input, output, restart/duplicate
   prevention and reconciliation. Mock/local dry-run is not a real publication.

## Maintenance risk requiring an architecture decision

The selected MinIO Community upstream now marks its repository archived on
2026-04-25. Its recorded release and commits can still be pinned for disposable
CI, but pinning does not establish future security maintenance. Production
needs an explicit supported-storage decision; no commercial service, license,
new object-storage implementation or data migration is selected implicitly.
Source: [official MinIO release/repository](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z).

The Bookworm artifact reports also contain residual vulnerabilities without
fixed versions. Reinstalling the same packages cannot close that gate. Any
OS/FFmpeg baseline replacement needs a material ADR, measured candidate scans,
compatibility/resource/output evidence and an independent review; it is not an
unreviewed transitive override or a promise that another distribution is clean.

ADR-010 is accepted only for the local/default-off implementation, following
the architect decision and independent scope review on 2026-10-03. External
provider rollout and production deployment remain unapproved. This status
correction grants no credentials, feature flags, storage selection or security
exception. Runtime preparation remains bounded by ADR-011 with external
admission disabled; local acceptance is not a credentialed provider canary.

## Safe order of remaining work

Read-only triage of the October 14 reports identifies the next small
remediation candidates: API `proxy-addr` compatible patch `2.0.7 -> 2.0.8`,
and an explicitly reviewed `perl-base` Bookworm security update. Neither has
been applied by this checkpoint. Required evidence includes official release
and compatibility checks, a scoped reproducible dependency/inventory change,
regressions and new exact-artifact scans. The edge also needs an official
artifact with updated embedded Go dependencies; updating Alpine packages alone
cannot patch its Caddy binary. Even those changes would leave unresolved
findings, including the OpenPGP advisory in the Go dependency closure.
Changing Bookworm, FFmpeg, an EOL dependency major, or the official-Caddy
packaging model needs a separate material architecture decision. Suppression
or reachability assumptions do not satisfy the current artifact policy.

Finish independently verified immutable runtime/edge preparation and reduce
remaining attack surface. Establish artifact/source security decisions and
production storage/recovery evidence. Then validate the private deployment
with approved configuration; enable at most one provider/channel for its exact
canary. Preserve manual export and switch admission off before any rollback.

No production deployment, external publication, port 3000 change or modification
of other projects is implied by this document. The development UI remains
<http://127.0.0.1:3100>.
