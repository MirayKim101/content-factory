# Static web-edge runtime preparation

Status: preparation only; final image packaging is blocked until the official
`caddy:2.11.7-alpine` image is published and can be pinned. This document does
not authorize a
deployment, public bind, TLS, DNS, access provider, credentials, or promotion.

## Fixed application boundary

- Nuxt remains `ssr: false`. The official Nuxt deployment guide documents that
  `nuxt generate` emits `.output/public/index.html` and browser bundles for a
  static SPA. The final build must therefore run `nuxt generate`, not ship a
  Node/Nitro server or use `nuxt build` as a runtime entrypoint.
- Browser API traffic remains the relative `/api/v1` contract. Caddy forwards
  only that prefix to the fixed private `api:3001` upstream without `handle_path`
  rewriting or request-selected upstreams.
- The prepared Caddyfile disables the admin API and automatic HTTPS, listens
  only on container HTTP port `8080`, emits JSON logs, rejects SPA fallback for
  missing asset paths, streams proxy bodies without explicit request/response
  buffers, and removes incoming forwarding metadata before proxying.
- Generated Nuxt files under `/_nuxt/` receive immutable caching only when the
  requested file exists. The SPA shell/deep-link fallback receives `no-store`.

## Exact Git build closure

`scripts/export-web-build-context.mjs FULL_COMMIT_SHA` materializes a new
context exclusively with `git ls-tree` and `git cat-file` from that full commit.
It records each selected blob and SHA-256 in `build-provenance.json`.

Included inputs are the root workspace manifests/lockfile/compiler base,
web manifest/Nuxt/TypeScript configuration, the complete committed
`apps/web/app` SPA tree, the Caddyfile, and the exact source closure declared by
`packages/contracts/package.json`. Tests, OpenAPI generation tooling, API/worker
source, environment files, editor state, `node_modules`, local data and every
untracked working-tree path are excluded. Symlinks and unexpected file modes
fail closed.

## Caddy v2.11.7 supply-chain hold

On 2026-10-03 upstream published signed Caddy `v2.11.7`, fixing the v2.11.6
HTTP/2 and one-minute stream regressions. The upstream release checksum list
contains the Linux AMD64 static archive SHA-512:

```text
a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7  caddy_2.11.7_linux_amd64.tar.gz
```

The release checksums file, its Sigstore signature, and certificate are all
published by upstream. Caddy documents the required signature-verification
process. However, the official Docker image registry does not yet contain
`caddy:2.11.7-alpine`; read-only manifest inspection returned `no such manifest`.

ADR-011 currently forbids v2.11.6, mutable tags, and substituting a release
binary in place of an official image. The architect has rejected those fallback
paths for this slice. A final Dockerfile must wait for the official
`caddy:2.11.7-alpine` tag, then record its immutable manifest digest and the
published leaf's exact operating-system details.

Until then, the exporter and configuration are reviewable preparation only; no
OCI image is buildable or promotable.

## Synthetic edge verification before the official image exists

`scripts/web-edge-smoke.test.mjs` exercises policy fixtures only: exact API
path/query forwarding, preservation of Range, content and idempotency headers,
removal of client forwarding headers, liveness, immutable existing `/_nuxt`
assets, missing-asset `404`, and no-store deep SPA fallback. It does not claim
that a Caddy binary has parsed or executed the configuration.

`scripts/web-edge-artifact-policy.test.mjs` is a separate Alpine/Caddy parser
contract. It requires exactly two Trivy inventories: the Alpine OS packages and
the Caddy Go binary, each with an explicit future-leaf-derived target string. It rejects
unknown scanner/database schemas, malformed or missing fields, stale/future DB
metadata, unsupported/missing platform, extra Node or other inventories,
injected Node/Yarn/Corepack/cache/root/app/source/build-tool files,
duplicate/missing Caddy Go-binary inventory, and every finding other than exact
`LOW` from either required inventory. It also verifies the intended offline
scanner isolation: two read-only mounts, non-root UID, read-only filesystem,
dropped capabilities, no-new-privileges, no network, and no Docker socket. The
actual Alpine version, Trivy target strings, SBOM package name/version/source
mapping, Syft creator string, OCI manifest and digest must be calibrated from
the future published official leaf and its actual scanner output. The synthetic
fixture values are not pins, release claims, or parser/runtime evidence.
The later real-image proof must record `caddy version` and a SHA-256 of the
executed Caddy binary alongside that immutable leaf; the policy accepts only
the reviewed `2.11.7` or `v2.11.7` SBOM version representation.

## Independently reproduced static-source acceptance

Prepared source candidate `4cdbba79e75272418be15257f5c979639745fc1b` was
independently reviewed against parent `086c3aa`. Main reproduced all 11 helper
tests, Prettier and Oxlint with warnings denied from an immutable snapshot.
Review corrections included mandatory Go inventory, explicit scanner targets,
case-insensitive missing-asset handling and the strict reviewed Caddy version.

Main also performed frozen filtered installation, `nuxt generate` and strict
web typecheck with Node 24.15.0 in `tmp/web-context-MHHaC4`. All 106 exported
source blobs were SHA-256-checked against their provenance; comparison with
final candidate `4cdbba7` found no changed input blob. The original generation
revision `927292d` is recorded rather than relabelled as a later build:

- generated static files: 219;
- `.output/public/index.html` SHA-256:
  `dc43f5862db4040b090df713a432e47ecf896c263a98ea6b310b1ee87513ea27`;
- `.output/server`: absent;
- private source/output proof:
  `tmp/web-context-MHHaC4/static-generation-proof.json`;
- exact final-closure comparison:
  `tmp/web-context-MHHaC4/final-closure-proof.json`;
- final candidate export context: `tmp/web-context-bo7WUF`.

The source release workflow now repeats the 11 preparation checks and static
generation from its own exact commit context. It asserts the SPA shell exists
and no server runtime is emitted. It builds no Caddy image, starts no edge,
publishes no host port and does not alter either hard dependency audit.
Nuxt's upstream unused-H3-import and plugin-timing warnings are not image or
runtime acceptance. Source/artifact security blockers still deny promotion.

## Required later image/runtime proof

After the image decision, use an exact commit context to prove `nuxt generate`
creates `.output/public/index.html`; final image inventory contains only Caddy,
static assets and configuration; and a non-root read-only diagnostic runtime
passes static/deep-link/cache, API method/query/range/idempotency, controlled
413/415/upstream-down, forwarding-header, bounded streaming, and desktop/mobile
browser checks. Artifact SBOM, provenance and offline all-severity scan remain
mandatory and cannot promote while source audits or recovery evidence are red.
