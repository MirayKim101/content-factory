# Production readiness — evidence, not a percentage

Updated: 2026-10-03. Current status: **production release blocked**.
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

## Mandatory unfinished gates

1. **Security of source/build and final artifacts.** Complete and production-
   classified dependency audits each still find two high advisories:
   [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and
   [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), with no published
   patched version in the recorded audit. Actual hardened API/migrate scans
   still deny promotion at 160/170 non-LOW records. Those counts are not unique
   CVEs or a percentage of readiness. The exact hardened worker scan denies
   promotion at 717 non-LOW records, down from its 743-record baseline; native
   dependencies and media/recovery behavior are unchanged. See
   `tasks/worker-runtime-hardening.md`. The web-edge scan is a separate gate.
   No allowlist, `ignore-unfixed`, severity reduction
   or final-image-only substitution for the source gate is allowed.
2. **Static web-edge runtime.** ADR-011 specifies static Nuxt SPA assets in a
   pinned Caddy image, with the fixed streaming `/api/v1` route. The build,
   image inventory, cache/deep-link behavior, streaming failures and real
   browser acceptance must pass independently of dev UI on port 3100.
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

Finish independently verified immutable runtime/edge preparation and reduce
remaining attack surface. Establish artifact/source security decisions and
production storage/recovery evidence. Then validate the private deployment
with approved configuration; enable at most one provider/channel for its exact
canary. Preserve manual export and switch admission off before any rollback.

No production deployment, external publication, port 3000 change or modification
of other projects is implied by this document. The development UI remains
<http://127.0.0.1:3100>.
