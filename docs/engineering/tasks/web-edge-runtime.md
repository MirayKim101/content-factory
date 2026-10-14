# Static web-edge runtime preparation

Status: diagnostic implementation, 2026-10-14. The official-image availability
hold is resolved; security, complete runtime acceptance and independent review
still gate delivery/promotion. This document does not authorize a
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

## Caddy v2.11.7 supply-chain history

On 2026-10-03 upstream published signed Caddy `v2.11.7`, fixing the v2.11.6
HTTP/2 and one-minute stream regressions. The upstream release checksum list
contains the Linux AMD64 static archive SHA-512:

```text
a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7  caddy_2.11.7_linux_amd64.tar.gz
```

The release checksums file, its Sigstore signature, and certificate are all
published by upstream. Caddy documents the required signature-verification
process. On October 3 the official Docker image registry did not yet contain
`caddy:2.11.7-alpine`; read-only manifest inspection returned `no such manifest`.

ADR-011 currently forbids v2.11.6, mutable tags, and substituting a release
binary in place of an official image. The architect has rejected those fallback
paths for this slice. A final Dockerfile had to wait for the official
`caddy:2.11.7-alpine` tag, then record its immutable manifest digest and the
published leaf's exact operating-system details.

That hold was resolved on October 14 as recorded below. Historical preparation
tests remain useful, but are not substituted for the native runtime proofs.

## October 14 native diagnostic implementation

Official documentation and registry were independently rechecked before the
build: [Caddy Docker operation](https://caddyserver.com/docs/running#docker-compose),
[reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[request body limit](https://caddyserver.com/docs/caddyfile/directives/request_body),
and [v2.11.7 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.7).
Registry responses were hashed and matched their content-addressed descriptors:

- official multiarchitecture index:
  `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`;
- AMD64 base manifest:
  `sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229`;
- base config:
  `sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77`.

`infrastructure/web-edge/Dockerfile` generates the actual SPA in a pinned
Node/pnpm builder and copies only static output, Caddy configuration and source
provenance into the official digest-pinned Caddy image. It removes the download
helpers `curl`, `libcap`, `mailcap` using the installed APK database without a
repository update. Their now-unneeded dependencies are also removed by APK.
The official Caddy binary bytes are not substituted. The image's existing
`cap_net_bind_service` file capability is removed before deleting libcap:
otherwise a non-root process with dropped capabilities cannot execute that
binary (the initial diagnostic startup reproduced `Operation not permitted`).
Port 8080 does not need that privilege.

The owned `infrastructure/web-edge/Caddyfile` keeps the reviewed static route
and adds a request body read limit of 10 GiB plus 1 MiB framing. Caddy's limit
applies to bytes read, not an oversized Content-Length header without a body.
Normal application JSON 413 propagation is a separate acceptance check; a
header-only experiment is not evidence of this read limit. There is no request
or response full-body buffering and no shortened upstream application deadline.

`scripts/web-edge-build-context.mjs` extends the existing static exporter with
exact regular Git blobs for the owned Dockerfile, Caddyfile and verifier. The
builder verifies the supplied full source revision, every content digest and
the exact directory inventory before installation. Branch/index changes and
pending API/worker files are not included. Prepared candidates are Git objects
for review, not branch delivery commits; the implementation owner does not push.

Runtime helpers `web-edge-runtime-proof.mjs` and
`web-edge-runtime-fixture.mjs` create only uniquely named `cf-edge-*` resources
in an internal network with no published host port. Edge, mock upstream and
client are non-root/read-only, cap-dropped/no-new-privileges, CPU/PID/memory and
log bounded. Helpers remove only their own named containers/network afterward.
No existing API, worker, data namespace or port is used.

Early native source `40216b5cc0d70d3a418e17069e5866cfc2139e78` passed 64 MiB
upload/download and a real 65-second response stream; evidence:
`tmp/web-edge-runtime-07814e30-b6cd-40a3-bb1f-b0b72d406a3b/runtime-proof.json`.
The stronger run against source `fe1e0e0271f98d22faf035f4672742c713944aa1`
passed 256 MiB multipart upload and download with SHA-256 verification at a
192 MiB container limit. Edge cgroup memory peak was 19,288,064 bytes; evidence:
`tmp/web-edge-runtime-a68bb080-ff8a-447b-aea0-eb4aed413e1a/runtime-proof.json`.
These proofs also cover liveness, SPA/deep-link/cache behavior, missing asset
404, fixed API method/path/query, idempotency/request/content/Range headers,
forwarding spoof rejection, 206/416, upstream JSON 413/415 and 504, upload
disconnect reaching the upstream, and a real edge-generated 502 after mock
upstream shutdown. The 504 case is explicitly upstream status propagation,
not a claim that the production edge has a newly configured timeout.

Intermediate implementation build candidate:
`722e23c79a5b55bbf220f41845e7dc1d21e6535c`, tree
`73bf0c09a14c734fd9f8b29c730eddf73e52fa41`, exact context
`tmp/web-context-bHsaYV` (109 files). The verifier's symlink/byte/inventory failure
tests and the earlier preparation tests pass together (now 13 tests). Formatting
and strict lint pass for the new JavaScript helpers. The final native build,
runtime rerun and actual digest-bound scan must be recorded below before those
particular artifacts are accepted; earlier-image proofs are not relabelled.

`web-edge-refresh-db.mjs` is the separate connected GHCR preparation step:
manifest and compressed layer digest/size are verified before extracting the
two exact DB files, and metadata must be schema 2 and at most 24 hours old.
`web-edge-scan.mjs` performs an offline all-severity scan of the immutable
BuildKit OCI archive using the existing pinned scanner tools, with no socket,
network or privileges. A policy/calibration failure still records a denied
artifact result. It does not change the two failing source audits or grant
promotion/deployment authority.

The supplemental sections below close rendered browser and actual API/media
checks. Independent review and clean security gates remain outstanding. The
504 check remains upstream status propagation, not a newly shortened production
proxy timeout. Earlier mock 413/415 alone were not
real NestJS upload-admission evidence; the backend's lifecycle/scratch cleanup
and idempotency/recovery gates remain separate. No production deployment,
public access, TLS, credentials, provider writes or image promotion is approved.

### Final native artifact and denied security gate

Final native build source `d47a7b7bb723012ee851a243c0824ed5b2f52028`, tree
`fc6b86f99b6a74208a0ddbf2786e7f910a253f36`, uses the 109-file exact context
`tmp/web-context-evwtAw`. The final Dockerfile has the mandatory
`io.content-factory.promotion=blocked-until-all-release-gates-pass` label.
BuildKit must be invoked with `--provenance=mode=max`; the plain OCI export
without an attestation was rejected by the existing artifact policy. Adding the
attestation reused the same build layers, manifest and config, without changing
runtime content. Retained final archive:
`tmp/web-edge-candidate-5RUowl/web-edge-attested.oci.tar`.

- OCI archive SHA-256:
  `59cc642c345e22adf283293714ac3dd2148691cd8b0304d80cb4dfc301f7ed2b`;
- final index:
  `sha256:9cb9f8edf36d9b8e69645f8bf3784142847085c63628763d8f9cdcd2c9dbad24`;
- AMD64 manifest:
  `sha256:08266425fcd0e0094626813878aabc7d055b7ed91f13c872118796a9d21663af`;
- config:
  `sha256:58c910b83a039505fcbe85c1a1ec04bf5fd361b8908f61100ba0eaad712f4ae8`;
- Caddy binary SHA-256:
  `678ade3bfc088749c81a681adc603333ee0bb023b6a6cfe3c0f58bef8ff854e9`;
- actual binary reports `v2.11.7`; actual OS is Alpine `3.23.6`.

Registry revalidation is retained in
`tmp/web-edge-registry-V0yZNW/registry-proof.json`, including exact public
index/leaf/config response bodies and checked digests, not the registry token.
Final native inventory and independent archive SBOM generation:
`tmp/web-edge-inventory-jQVupp/inventory-proof.json`. It confirms relative
`/api/v1` public config and `aiContextEnabled=false`,
`editorialFramesEnabled=false`. There is no API/worker process, provider
credential or deployment configuration in this image.

Final runtime smoke:
`tmp/web-edge-runtime-f17b2b9b-c90c-47e0-84da-8fb061a9de81/runtime-proof.json`
is PASS. Its inspected runtime manifest matches the final OCI leaf above.
256 MiB multipart upload/download pass checksum verification, the stream lasts
65,001 ms, upstream shutdown produces 502, and the edge's recorded cgroup memory
peak is 19,664,896 bytes against a 201,326,592-byte limit. This is edge/mock
transport evidence, not a claim about NestJS multipart parsing or media jobs.

The fresh GHCR DB is retained immutable for shared read-only scans at
`tmp/web-edge-db-4kv0cK`; `refresh-proof.json` records descriptor verification,
metadata schema 2 and `UpdatedAt=2026-10-14T07:11:52.271767627Z`.
Metadata SHA-256 is
`2ef42001cc6955f212ad8c1e90e6885e6570d32d2141e928a5fc6ad1449475c6`;
DB SHA-256 is
`88daf0f4f0789698811bec5ebf95ef9610cd0f4d0571394f754a5cdb8cf081c9`.
The verified compressed artifact is 133,519,111 bytes; current `trivy.db` is
1,620,275,200 bytes. A first 1 GiB extraction bound correctly failed; the
already verified compressed artifact was reused without another download and
extracted to a new directory with a hard 2 GiB bound. Earlier partial cache
directories are not valid scan inputs. No scanner performs a network DB update.

The actual offline scan at `2026-10-14T11:50:59.642Z` covered both inventories:
17 Alpine packages and 149 Go packages in `usr/bin/caddy`. The calibrated SBOM
parser accepts Syft's exact relative binary path, linked
`cloud.google.com/go/...` module names and the ordinary OS file
`etc/crontabs/root`; these do not imply a Go compiler or a `/root` home tree.
Literal Go toolchain packages/paths, root-home files, traversal paths and all
previous Node/build-tool injections still fail tests. No severity policy changed.

Result: **artifact gate DENIED**, 19 non-LOW findings: 4 HIGH, 8 MEDIUM,
7 UNKNOWN; 1 further LOW finding is retained in the report. Findings include
Alpine zlib `1.3.2-r0` and linked Go `stdlib`, `golang.org/x/net` and
`golang.org/x/crypto`. No dependency override, substituted Caddy binary,
allowlist, filtering or promotion was attempted.

- scan evidence: `tmp/web-edge-scan-S9EHoB/evidence.json`;
- all-severity raw report: `tmp/web-edge-scan-S9EHoB/trivy.json`;
- scan SBOM: `tmp/web-edge-scan-S9EHoB/sbom.spdx.json`;
- report SHA-256:
  `5281ed95550ad67f5d2b02d6bc315bb798f690505b41fa19732541f9ccbc0ca4`;
- scan SBOM SHA-256:
  `785cd77085f13fbf118776d7028ba34f3348d4ea18841564084b170368b89a30`.

Reproduction uses the same source/exporter, Node 24.15.0, pnpm 10.34.5 and
pinned scanners. Export with `node scripts/web-edge-build-context.mjs FULL_SHA`;
build inside the returned directory using its own
`infrastructure/web-edge/Dockerfile`, `--platform linux/amd64`,
`--provenance=mode=max`, `--build-arg SOURCE_REVISION=FULL_SHA` and OCI output.
After loading that image, run `node scripts/web-edge-runtime-proof.mjs
content-factory-web-edge:diagnostic-SHORT_SHA` and
`node scripts/web-edge-scan.mjs OWNED_OCI_ARCHIVE OWNED_FRESH_CACHE FULL_SHA`.
The last command currently returns non-zero by design because the actual gate
is denied. A later expired DB must be refreshed separately, not ignored.

Rollback remains non-deployment: do not use these diagnostic images for release;
the helpers clean only their own temporary containers/network. No existing
runtime, production Compose, schema or data is changed. Keep the shared fresh
DB immutable while Main/other readers scan it. Full source audits, real
API/media/recovery integration through edge, browser rendering, independent
review, deployment facts and owner deployment approval remain separate gates.

### Closed handoff and browser availability

The stricter final parser was also exercised against another actual offline
scan, not only synthetic fixtures. The repeated result remains 19 non-LOW
findings, with no parser/calibration error:
`tmp/web-edge-scan-fq0ud9/evidence.json`, scan start
`2026-10-14T11:54:11.296Z`.
Its raw report SHA-256 is
`760042197c0a538ff3b5f7fa0bd2e363067f8b8729051633c8297d1e78901a1a`;
SBOM SHA-256 is
`ab4326d39552b512d9d784d1ce85da249c628eaa22db7e0cd7fc99fd5b3edc94`.
The archive/manifest/config/DB hashes are unchanged.

Native browser availability was checked explicitly on October 14. No Chromium,
Chrome or Firefox executable is in PATH, and no Playwright/Puppeteer package is
present in the checked repository and supplied closed dependency graphs.
Cached Chromium exists at
`/home/miray/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`, but
`--version` fails before startup: `libnspr4.so: cannot open shared object file`.
The cached headless-shell binary fails with the same error. `ldd` additionally
reports missing `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, `libasound.so.2`.
At this initial host-only check, rendered browser verification was pending, not
passed. The later authorized disposable-container verification below closes that
gate without changing the host. The initial native HTTP SPA/deep-link checks
alone were not presented as rendered UI proof.

The implementation owner changes only these fourteen paths:

1. `infrastructure/web-edge/Caddyfile`;
2. `infrastructure/web-edge/Dockerfile`;
3. `infrastructure/web-edge/verify-context.mjs`;
4. `scripts/web-edge-artifact-policy.mjs`;
5. `scripts/web-edge-artifact-policy.test.mjs`;
6. `scripts/web-edge-build-context.mjs`;
7. `scripts/web-edge-context.test.mjs`;
8. `scripts/web-edge-inventory.mjs`;
9. `scripts/web-edge-refresh-db.mjs`;
10. `scripts/web-edge-registry-proof.mjs`;
11. `scripts/web-edge-runtime-fixture.mjs`;
12. `scripts/web-edge-runtime-proof.mjs`;
13. `scripts/web-edge-scan.mjs`;
14. `docs/engineering/tasks/web-edge-runtime.md`.

No API, worker, lockfile, production Compose or global handoff modification is
part of this slice. Frozen review candidate
`55d76d3e57d259788d4fedf4f61ad483411b9725` initially closed those owned changes;
`tmp/web-edge-review-ZYVsla/image-input-comparison.json` proves all 109 native
image input blobs match the built source `d47a7b7`. A later documentation-only
closure does not relabel the actual built image revision.

Independent review remains required from the orchestrator's separate reviewer:
inspect the real owned diff, reproduce the thirteen helper tests and strict
format/lint checks, verify the official base and OCI provenance, and reproduce
native runtime and denied all-severity scan using the shared fresh DB. The
implementation owner's report is not independent acceptance. No branch commit
or push is performed by the implementation owner.

### Initial rendered browser verification: bounded hydration/geometry PASS

Main explicitly authorized a disposable browser client and read-only SPA access
on `cf-worker-capacity-20261014_proof`. Official Playwright Docker/browser docs,
its native dependency list and Debian Bookworm NSS package information were
checked before installation. No host libraries or application dependencies were
installed. The existing cached headless Chromium binary was mounted read-only
into a separate diagnostic container based on immutable local worker image
`sha256:c39f7b2300ba912c9c6af3067825549f2ea109ee61d2938b1210803e7ea55d5a`.
Only this private client's missing libraries were installed with explicit pins:

- `libnss3=2:3.87.1-1+deb12u4`, `libnspr4=2:4.35-1`;
- `libatk1.0-0=2.46.0-5`, `libatk-bridge2.0-0=2.46.0-5`;
- `libatspi2.0-0=2.46.0-5`;
- `libxcomposite1=1:0.4.5-1`, `libxdamage1=1:1.1.6-1`.

APT logs and full before/after package inventories are retained privately.
The resulting test-client image is
`sha256:863b91d6f5cd51baad300fc460a2e5edffa6ec342aa0774904b1dbd935d66956`;
it is not a production image or a replacement worker. No Main service was
modified. The browser runs separately as UID 1000, read-only/cap-dropped with
no-new-privileges, bounded CPU/PIDs/memory/tmpfs and no published ports, on only
the authorized internal network. It uses `--no-sandbox` solely for this trusted
diagnostic browser, not for web-edge/API/worker deployment. The preparatory
container was removed after its logs and fixture were saved.

Native Chrome DevTools Protocol over child-process pipes avoids installing a
Playwright npm package or opening a debug port. Fetch interception allows only
same-origin GET/HEAD and rejects mutations/external requests. The actual
Caddy-served SPA was rendered at 1440 and 390 pixels on six routes: library,
horizontal, montage-assets, vertical, sources and publications. All twelve
checks pass within the initial harness's limited scope: correct route/hydrated
heading, no horizontal overflow, no early uncaught JS exception and real
same-origin API health 200. Early natural domain API responses remained below 500. Eight visible selectors were opened with a synthetic DOM click and had
positioned, opaque, viewport-contained overlays. Escape events were sent, but
closure was not asserted; no keyboard selection was tested. This is not settled
operator acceptance: the initial wait could exit before dependent domain loads,
late network errors were not exhaustively collected, and the original montage
screenshot still contains a loader/open popup. Those initial proofs and images
are preserved unchanged, not relabelled as stronger evidence. Pages
may legitimately defer a domain query until a project is selected; the
browser health fetch independently proves actual API transport on every route.

- browser version: `HeadlessChrome/156.0.8078.4`;
- cached browser binary SHA-256:
  `4fa61f0ba0b4f89b7bec242c32ca16d3bccf69dbfef0651924a9ba8fede5f9d6`;
- closed browser evidence and runtime inspection:
  `tmp/web-edge-browser-20261014/browser-evidence.json`;
- rendered results: `tmp/web-edge-browser-20261014/actual/browser-proof.json`;
- result SHA-256:
  `4c407b0e0f43b20f139dea17abf8d4632ffdc86c842251e73f550bf675d07354`;
- twelve screenshots: `tmp/web-edge-browser-20261014/actual/*.png`;
- replayable private CDP runner:
  `tmp/web-edge-browser-20261014/render-smoke.mjs`.

The source/provenance/final image and its 19 non-LOW findings are unchanged.
Browser PASS does not grant promotion or imply worker/media recovery acceptance.
Main's explicit readiness was required before submitting any new edge integration
project/job while Main exercised recovery on the shared diagnostic namespace.

### Supplemental actual API/media integration through edge: PASS

After Main's explicit GO, a separate edge/client on the authorized internal
`cf-worker-capacity-20261014_proof` network exercised real
`content-factory-api:pcre2-u2-83f9d4b` and
`content-factory-worker:capacity-proof-0c9cf33`. No host port, mock API, provider
credential, Main service restart/kill or Redis mutation was used by this owner.
API capabilities confirmed Twitch ingestion, vertical rendering and publishing
remain disabled.

New normal project `5f7e0c9c-5e18-4dc1-82c7-e9792bd10019` passed upload replay,
initial rights denial 403, explicit manual source authorization, actual FFprobe,
source checksum/download and 206/416. The first cut response was deliberately
lost by destroying the client socket after 201 headers without reading its JSON;
two identical replays returned the same request/job. The project's authoritative
cut list contains one persisted cut job. Job
`b3a79918-294d-4eeb-95e6-f2532e36b87b` reached READY on attempt 1, downloaded
20,681 bytes with SHA-256
`801aa4563cba3cbbc243d6b51dd25572b4c445137b563a19ca60203c7e4dddff`;
result Range 206 and 416 also passed. Source fixture SHA-256 is
`909a905add347b2d4dd1f85e0ec9cb301371ec7b1d9d9d8a7be271a246f21251`.

The actual API returned JSON 415 `INVALID_MP4` and 413 `UPLOAD_TOO_LARGE`
through Caddy. A second own uploaded project
`bea6f7a1-4bc5-4a31-8cdf-b0ad8a45008b` retained valid MP4 structure but zeroed
encoded samples. Job `933d9f3c-437d-4090-a8ea-7ca5bd114d7f` reached controlled
FAILED_FINAL with `FFMPEG_CUT_FAILED`, no result and no derived cut artifact.
Read-only scratch inspection after these requests found zero API `request-*`
directories and only `worker-ready` in worker scratch.

A separate own client used a PostgreSQL READ ONLY transaction to verify exactly
one READY cut artifact and lineage source version 1 for the normal job, and zero
cut artifacts for the failed job. The initial audit assertion counted all three
project artifacts incorrectly: two legitimate `source-ingest-v1` records plus
the cut. The harness was corrected to discriminate `pipelineJobId`; the retained
inventory records all three and the correction explicitly. No fixture or data
was deleted to obtain a pass.

- actual HTTP scenario: `tmp/web-edge-browser-20261014/media/media-through-edge.json`;
- scenario SHA-256:
  `589cbe1722cb22fc2a84019a100fd2b480efc532248a0d1b704605b63e83300d`;
- read-only artifact audit: `tmp/web-edge-browser-20261014/media/artifact-audit.json`;
- combined inspection/hash/cleanup evidence:
  `tmp/web-edge-browser-20261014/media/integration-evidence.json`;
- combined evidence SHA-256:
  `0bafe0a799d45781960a688dfb967ad921d3e0d8f1070a4a0da278303167aa76`.

Main separately performed actual stop, Redis DB0 loss and SIGKILL/recovery on
this exact worker. Its immutable proof remains
`tmp/worker-capacity-native-GGLAT7/final-media-proof.json`, SHA-256
`c1c327d83d4386bb98192202f94a0b15858665e52f722399e3a28d69cd4232d2`.
Our separate read-only client then independently fetched all three recovered
jobs/results and Range responses through Caddy, matching Main's exact checksums:
normal attempt 1, queue-loss-recovered attempt 1, killed/recovered attempt 2.
Those checks are retained at
`tmp/web-edge-browser-20261014/media/recovered-through-edge.json`.
We do not claim to have performed Main's disruptions or originally submitted
those three jobs through edge. Main's first empty-DB12 harness failure is
preserved by reference rather than relabelled as a successful DB0 flush.

The bounded edge smoke is supported by initial browser, real API/media,
transport-failure/replay and recovered-output evidence. This does not override
the unchanged artifact DENY-19 or source audit blockers. Independent review and
any production/deployment acceptance still remain mandatory.

### Follow-up UI polish and stronger browser baseline (2026-10-14)

Checkpoint `993524e533a5fe1db966f797fa8bf88c8de4c274` closed the preceding
source slice. The follow-up owns only shared select presentation CSS, vertical
empty-state copy, focused web tests and this task document. API/contracts,
generated client, manifests, lockfile and Dockerfiles are not changed here.

The private strengthened runner is
`tmp/web-edge-browser-20261014/render-settled.mjs`. It uses genuine CDP pointer
and keyboard events, Tab/Shift-Tab focus, explicit Escape closure/focus checks,
ArrowDown active-descendant and Enter/ARIA-selected checks. It waits for empty
active-request inventory, stable DOM and absence of visible busy/loading text,
with a hard failure deadline, both initially and after selection. Network
responses/failures and runtime exceptions are observed throughout each route,
including a final quiet tail. Same-origin GET/HEAD interception fences mutations.
It records exact option rectangles and clipped text rather than calling an
ellipsis a successful wrap. It remains bounded sampling, not an exhaustive
operator workflow or a proof against arbitrary future polling errors.

Initial strengthened baseline against the existing `diagnostic-d47a7b7` image:
`tmp/web-edge-browser-20261014/settled-baseline2/settled-proof.json`.
All twelve desktop/mobile routes settle with loaders absent, no 5xx, no network
failure and no uncaught application exception. All eight exercised comboboxes
pass native pointer opening, Arrow/Enter selection and Escape closure/focus.
Overall baseline is nevertheless **FAIL**: eight duplicate focus-outline cases
and six project-popup truncation cases. The focused node is PrimeVue's inner
`span[role=combobox][data-pc-section=label]`, with UA outline
`rgb(16, 16, 16) auto 1px`, inside a root with the existing purple 3px outline.
The prior private `settled/` attempt failed in the harness itself on an early
null document root; it is retained and is not application-failure evidence.
The strengthened baseline JSON SHA-256 is
`79d1ee578df90cd48daa335fd9c8619a2c4b6aec2ccc251b0b7a8498415cbb01`.

Montage assets settle to a denial, not successful material loading: actual
`GET /api/v1/projects/{id}/montage-assets?limit=50` returns
`403 MONTAGE_RIGHTS_REQUIRED`, with the explicit message that separate montage
rights evidence is required and this slice supports only local development
policy. The manual-mode API is enforcing its existing boundary. No authorization
bypass, policy change or automatic retry-to-success is introduced. The browser
can verify the safe error state, but cannot claim normal montage-assets operator
acceptance on this runtime. Source authorization alone is not montage rights.

The bounded product patch removes only the native outline on the inner
non-editable select span; the parent `:focus-within` ring remains and gets the
opaque brand color for keyboard `:focus-visible`. No role, tabindex, keyboard
handler or ARIA attribute changes. Popup labels wrap, including long unbroken
filenames, while the closed selected value retains compact ellipsis. Vertical
empty-state instructions no longer assume that the composer is on the right;
the existing single-column breakpoint remains unchanged.

Focused source checks pass: the actual PrimeVue `ProjectSelect` unit test
(`apps/web/test/project-select-keyboard.spec.ts`), strict Oxlint of that test,
Prettier of all four owned paths and scoped `git diff --check`. The first unit
attempt asserted Escape synchronously and failed; PrimeVue intentionally hides
the popup using `setTimeout(0)` for screen readers. The test now waits for the
real ARIA-expanded change rather than changing component behavior or weakening
the assertion. Unit DOM simulation does not replace native browser verification.

At this initial source handoff, final web unit/type/lint/build and rendered
verification were pending Main's combined frozen candidate and stable lockfile;
they were not implied by the old image baseline. The following section records
the subsequent exact-candidate verification. Independent review and artifact
**DENY-19** remain mandatory; this polish grants neither promotion nor deployment.
Rollback is the scoped CSS/copy/test revert and rebuild of a reviewed static
image, without API/schema or persisted data changes.

### Combined e17 candidate: web gates, actual image and bounded UI verification

Main supplied exact candidate `e17b10c5449c0b72b248fc68e6bb9e32fb3b8f75`, tree
`a6f5f6eb5715ed7ffec5bba1cbd38266190ab577`, parent `993524e`. Its 109-file image
context is `tmp/web-context-pVYWuW`. A separate closed web gate fixture includes
the candidate's 54 committed test/config files in addition to those exact
inputs. Dependencies from Main's verified cold fixture
`/tmp/cf-proxy-addr-source-aJZJtl` were reused only after byte-hash equality of
17 lockfile, manifest and exact contracts closure files. No installation or
lockfile edit was performed by this owner. Fixture/source/dependency provenance:
`tmp/web-edge-final-e17-Er5Uq6/source-gate-provenance.json`.

Full checks pass on that closed source: 51 web test files / 278 tests; strict
Oxlint over app/tests/Nuxt/OpenAPI tooling; Nuxt typecheck; and static
`nuxt generate`. Logs and exit codes are retained under
`tmp/web-edge-final-e17-Er5Uq6/gates-prepared/`. The first attempt ran unit tests
before generating `.nuxt/tsconfig.json` and failed before executing any test;
its original log/result remain. Adding the normal `nuxt prepare` prerequisite
in the private runner fixes fixture preparation, not product source. All 13
edge/export policy helper tests and scoped source formatting also pass.

Official Caddy tag/index/leaf/config were independently reverified again in
`tmp/web-edge-registry-Py4fiu/registry-proof.json`. The exact context's own
Dockerfile built with `BUILDX_GIT_INFO=0` and `--provenance=mode=max` into
`content-factory-web-edge:diagnostic-e17b10c`. Actual immutable archive:
`tmp/web-edge-final-e17-Er5Uq6/web-edge-e17.oci.tar`.

- archive SHA-256:
  `5c983de4040b43529f28d495b1f7e46949c4e97c5c3cbd29f7bc98b369b3746d`;
- index: `sha256:b06fbe244ba4fe9421998c692a9f47a727de61ee3c4a9a17940083d43f09b8fd`;
- AMD64 manifest:
  `sha256:2d0264dc94c0d760c459197e7b564b5bcb3c8969abc9b9f5f76c7b01cf5b31dd`;
- config: `sha256:6f0b9a7743933a7c4fdaa27203c9057e6e6ac5d7001deb57707541020373de08`;
- provenance attestation:
  `sha256:1903aa71ec84aae3e5770cc297cd15c0867703330eb7dc90518cc98daf07170b`.

Native inventory at `tmp/web-edge-inventory-8njBX1/inventory-proof.json` verifies
Caddy v2.11.7, unchanged official binary SHA-256 `678ade3b…854e9`, Alpine 3.23.6,
relative API config and both AI public flags false, without Node/Nitro/build
runtime. An initial inventory Docker client invocation timed out at 30 seconds
despite returning completed inventory/exit status 0; it was not accepted. The
separate repeated native inventory completed normally and is the proof cited.

Fresh offline all-severity scan at `2026-10-14T13:08:40.519Z` is **DENIED**:
4 HIGH, 8 MEDIUM, 7 UNKNOWN, and 1 additional LOW retained. Inventories are
17 Alpine and 149 Go packages. The immutable shared `web-edge-db-4kv0cK` DB was
21,408,248 ms old (under 24 hours); its metadata timestamp and digests remain
unchanged. No refresh, filtering, threshold change or exception was introduced.
Evidence: `tmp/web-edge-scan-V6qeZk/evidence.json`; raw report SHA-256
`29e775483b632b68ffd9ef3d6b951e5268670ea32f8b2925edb117ad032cebb9`;
SBOM SHA-256 `257c1687284c8024cb505defccf0ae5ab5611c53d293eb46dd3bf8c737ac0244`.

New-image transport runtime proof is PASS at
`tmp/web-edge-runtime-13627f0a-b58f-4a48-9258-a75ae95e8e49/runtime-proof.json`:
256 MiB upload/download checksums, 65,002 ms stream, disconnect, Range,
413/504 upstream propagation and actual edge 502. Memory peak 20,217,856 bytes
against 201,326,592-byte limit. Mock transport and actual NestJS tests remain
separate evidence.

Private native browser proof now exercises twelve route/viewport pairs plus
four actual cleared/unreviewed source workspaces, all at 1440/390 pixels.
`tmp/web-edge-final-e17-Er5Uq6/browser-loopback/validated-browser-proof.json`
records **PASS_BOUNDED_FUNCTIONAL**, not full operator/release acceptance.
It proves eight keyboard comboboxes, visible solid 3px parent focus with
non-drawable inner outline, real Arrow/Enter selection and Escape closure,
wrapped/nonoverlapping long options, viewport containment, neutral vertical
copy, settled domain loaders, no unexpected network error, no late 5xx,
no uncaught JS exception and no mutation/external request.

Important retained diagnostic boundaries:

- The first new-image focus classifier falsely interpreted Chrome's computed
  `rgb(23, 32, 51) none 3px` as a drawable inner outline. Its raw FAIL proof and
  screenshots remain in `browser/`. The corrected private check requires a
  drawable outline style and positive width; product source/image did not change.
- A private runner self-source recording attempt passed a file-URL string to
  `readFile` and failed before checks; its failed invocation and inspected
  exit status are retained. The cleanup log captured stdout only, so it does
  not retain this invocation's stderr; this is a known evidence limitation. The
  corrected runner uses a URL object and records its own exact source/hash.
- Non-loopback plain HTTP Docker origins cannot supply `crypto.randomUUID()`;
  selecting a source reproduced a caught Nuxt 500 page. Those failures remain
  in `browser-final/`. Final browser runs share only the owned edge's network
  namespace and use `http://127.0.0.1:8080`, with native secure-context/UUID
  assertions. No host port, insecure-origin override, certificate exception or
  product fallback was added. This follows the browser
  [secure-context loopback rule](https://www.w3.org/TR/secure-contexts/), and
  proves neither TLS nor arbitrary HTTP LAN-hostname operation.
- Raw loopback proof retains two `Network.loadingFailed` events and raw FAILs:
  native HTML-video preload canceled after 206. The separate validator accepts
  only exact source URL/request ID, `Media`, `net::ERR_ABORTED`, `canceled=true`,
  matching 206 response and an actually decoded `readyState=4` video. Five
  negative classifier checks reject other errors/statuses/missing video. Both
  events remain in the validated proof; no generic network-error suppression.
- Montage still renders the safe negative state. The unreviewed fixture gets
  `SOURCE_AUTHORIZATION_REQUIRED`; after selecting a cleared source it gets
  `MONTAGE_RIGHTS_REQUIRED`. Ordinary montage material loading/upload under
  manual policy is **not accepted**. The approved future attestation design is
  a later slice, not an authorization bypass in this checkpoint.

Actual API/media rerun against the stable old Main API `pcre2-u2-83f9d4b` and
worker `capacity-proof-0c9cf33` is retained under
`tmp/web-edge-final-e17-Er5Uq6/media/`. Normal project
`7497c8f0-d9a2-4111-8592-eae639a1d0e1`, job
`14b4551f-66c8-4030-ae21-d00a79d68777`, passed upload replay, manual rights,
probe, lost-response cut replay, READY attempt 1, 20,681-byte result with SHA-256
`801aa4563cba3cbbc243d6b51dd25572b4c445137b563a19ca60203c7e4dddff`, and 206/416.
Real JSON 413/415 and corrupt-source `FFMPEG_CUT_FAILED` also pass. PostgreSQL
READ ONLY audit finds exactly one normal cut artifact with recipe
`stage1-cut-h264-v3`/source version 1 and zero failed-job cut artifacts. API
request scratch is empty; worker scratch contains only `worker-ready`.

`media-through-edge.json` preserves an initial harness FAIL after all core
media checks passed: the extra unreviewed UI fixture incorrectly awaited probe
duration before rights clearance. `media-through-edge-validated.json` resumes
that same existing unreviewed project using GET-only NOT_REVIEWED/usable=false
and source-403 assertions, without another upload or attestation. Read-only
checks of Main's three previously recovered outputs also pass through this new
edge; stop/Redis loss/SIGKILL remain Main's earlier disruptions, not ours.

These initial API/media results bind the new e17 edge to the explicitly named
old API/worker images; they are not relabelled as combined e17 backend acceptance.
Main subsequently prepared the separate `cf-security-e17-20261014` namespace and
gave explicit GO after its recovery exercise. The following subsection records
the new combined-image run. No new-namespace jobs, stops or Redis mutations were
initiated before that GO. Source product files remain identical to frozen e17;
only this task document and private evidence are updated after freeze.
Independent review, clean security gates and deployment approval remain
outstanding.

Closed web/old-backend evidence:
`tmp/web-edge-final-e17-Er5Uq6/closed-web-evidence.json`, SHA-256
`aae935e0b23527443ae5d086f2796f2fa8230a0096c7c4f37fb7edb52c419722`.
Only nine explicitly owned old-network diagnostic containers were removed;
`old-network-cleanup.json` retains their names. Main's services/network, images,
fake fixture projects and all initial/raw/new proofs remain unchanged.

### Final combined e17 API/worker/edge acceptance

After Main's explicit readiness, five separately owned
`cf-webedge-integration-20261014-combined-e17-*` containers used only
`cf-security-e17-20261014_proof`. The actual backend images were verified
against Main's proof and their revision labels, not inferred from mutable tags:

- API `content-factory-api:security-e17b10c`, image ID
  `sha256:276a867355666d81b8b789613fdddef713682c119be8c9ba08e940e9c3f9b42c`;
- worker `content-factory-worker:capacity-proof-e17b10c`, image ID
  `sha256:94036362ac801a71d593d7dd7c68d56cab63b1fdf2af802a8301d2ef3b5f212b`;
- edge is the exact e17 index/archive above, with no rebuild or source change.

Actual combined HTTP/media scenario passed on the first run in 9,868 ms:
`tmp/web-edge-final-e17-Er5Uq6/combined-media/media-through-edge.json`.
Normal project `89147114-9b50-420b-be07-ebd845bb717e`, cut job
`ddf7ed78-e9c6-46e2-a50f-41a3a947dba6`, passed upload replay, initial source-403,
manual source authorization, probe, source/result checksums, 206/416,
lost-response cut replay and READY attempt 1. Result is 20,681 bytes with SHA-256
`801aa4563cba3cbbc243d6b51dd25572b4c445137b563a19ca60203c7e4dddff`.
Real JSON 413/415 pass. Corrupt-source project
`57051b96-7177-4d3e-a52d-99a35d99c0c2`, job
`5fea164d-2ef0-40de-82f4-977d9c8c03ad`, fails safely with
`FFMPEG_CUT_FAILED` and no result artifact. A third own unreviewed project
`b704ecf4-e6c8-47bd-a81f-c7cfcd7dfbc7` remains NOT_REVIEWED/usable=false with
source-403; no premature probe-duration expectation or authorization bypass.
PostgreSQL READ ONLY audit confirms exactly one normal cut artifact, recipe
`stage1-cut-h264-v3`/source version 1, and zero failed-job cut artifacts. Request
scratch is empty and worker scratch has only `worker-ready`.

The exact same native browser runner then repeated all sixteen desktop/mobile
scenarios against the combined backend, with eight keyboard comboboxes, actual
long-option wrapping, no row overlap, preserved solid parent keyboard focus,
Escape closure/selection checks and responsive-neutral vertical copy. Source
preview is decoded at `readyState=4`; an unreviewed source shows the rights
refusal without a video. Raw proof retains the two expected media preload
cancellations as FAIL; the separate strict validator establishes
**PASS_BOUNDED_FUNCTIONAL** with those exact two events disclosed. Zero unexpected
network failures, zero late 5xx, zero uncaught JS exceptions and zero blocked
mutation/external requests. Montage safe source/montage-rights refusals remain
visible and ordinary montage happy-path acceptance remains blocked.

- final raw browser proof and exact runner:
  `tmp/web-edge-final-e17-Er5Uq6/combined-browser/settled-proof.json` and
  `combined-browser/runner-source.mjs`;
- classified proof: `combined-browser/validated-browser-proof.json`;
- final screenshots: `combined-browser/1440-montage-assets-keyboard-focus.png`,
  `390-montage-assets-pointer-open.png`, `390-vertical-final.png`, and cleared /
  unreviewed horizontal source screenshots in that same directory;
- read-only audit: `combined-media/artifact-audit.json`;
- independent recovered-output downloads/Range:
  `combined-media/recovered-through-edge.json`.

Main's combined runtime proof is
`tmp/security-maintenance-20261014-0MOH8w/combined-runtime-proof.json`, SHA-256
`beacfe48dc3e3acc3c890822daa32e8148d30c290aaf0dfd9e87e60b52c22142`.
This owner's separate read-only client checks its normal, queue-recovered and
SIGKILL-recovered jobs through the new edge, matching checksums and attempts
1/1/2. Redis DB0 loss (18 keys to 0), SIGKILL 137 and graceful exit 0 are Main's
disruptions; none were performed by the edge owner.

A second actual offline scan of the identical e17 OCI was performed at
`2026-10-14T13:29:38.290Z`: **DENY-19**, 4 HIGH / 8 MEDIUM / 7 UNKNOWN, plus
1 retained LOW. DB age was 22,666,019 ms. Source-independent artifact evidence:
`tmp/web-edge-scan-elY3yq/evidence.json`; raw report SHA-256
`055f323be095d0ac7a3cf6757ff5f2d52ff7ecca29fd468d811903b199d49067`;
SBOM SHA-256 `258fa8f9f9e538f7c19eca20ef8b7eeb56f69979f0bd1ded4f4cca82caea5299`.
This is a real all-severity rerun, not a carried-forward finding count. No
security gate exception or production promotion was introduced.

Final source/image/runtime/browser/backend/hash closure:
`tmp/web-edge-final-e17-Er5Uq6/final-combined-evidence.json`, SHA-256
`9a27094d57915b6753fd7bfea74818572d1783447215ebebb04c64e49c66548d`.
Both stdout/stderr logs and inspected security/network settings are retained
for all five final own containers, which were removed only after closure.
`combined-cleanup.json` records their exact names. Both Main namespaces, their
services/data, diagnostic images and review fixtures are preserved. No host port,
Main stop/kill/flush/configuration change, protected path access, branch commit
or push was performed by this owner. Product CSS/component/test bytes still
match frozen e17; this final task-document supplement needs Main's separate
review/commit, not an image rebuild. The bounded functional slice is complete;
release remains denied by security gates, and independent review, manual montage
capability, private-access/TLS/deployment facts and approval remain outstanding.

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
