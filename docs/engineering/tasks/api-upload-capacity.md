# API upload staging capacity

This bounded API slice reserves each HTTP upload endpoint's Multer `fileSize`
maximum before Multer reads source bytes. The process-local coordinator keys a
ledger by filesystem device identity, not the configured directory path, so
source, montage, editorial-thumbnail and creator-reference uploads sharing one
filesystem compete for the same reservation.

The closed runtime inventory is exactly four Multer-backed temporary writers:
source project upload, montage asset upload, editorial thumbnail upload and
creator-reference upload. There is no fifth controller or temporary disk writer
outside the shared lifecycle and storage implementation.

`API_UPLOAD_STAGING_SAFETY_BYTES` is a non-negative integer. It is required
when `DEPLOYMENT_PROFILE=other`; local and test processes may use zero. An
`other` diagnostic fixture may explicitly use zero, but production must use a
measured nonzero reserve. The API refuses a reservation when `statfs` cannot be
read or available space cannot cover the safety reserve plus every outstanding
maximum reservation. It returns only HTTP 503 `UPLOAD_STAGING_UNAVAILABLE` with
the generic public message.
Filesystem `ENOSPC`, `EDQUOT` and `EFBIG` while writing are mapped to the same
response. Existing Multer size enforcement remains HTTP 413.

Before any staging-root filesystem operation or path normalization, the
coordinator lexically rejects protected directory names (including accent
variants). It then walks existing parents with `lstat`, never resolves symlink
targets, and refuses a symlink or non-directory component. Malformed filesystem
capacity statistics fail closed. The configured root must already be owned by
the API runtime UID with exact `0700` permissions, or be newly created that
way; an existing root is never chmod-repaired. The permissions check includes
all special bits (`mode & 0o7777`): sticky, setgid and setuid roots are refused
even when their ordinary permissions are `0700`.

Reservations release on normal completion, parser error, disconnect, abort and
temporary-directory allocation failure. A request cleanup may mark a reservation
for release, but its bytes remain reserved until every owned write stream has
closed. This is intentionally a one-API-process safety mechanism; multiple API
replicas require an architect-approved shared admission budget before rollout.

The separate montage active-upload limit of two remains a business admission
rule. It does not create a second disk-capacity calculation.

Rollback is a reviewed revert of the API configuration, lifecycle/interceptor,
storage tracking and endpoint metadata together. It does not modify database
state, object storage, worker behavior or uploaded artifacts.

## HTTP failure and ownership proof (2026-10-14)

`apps/api/test/upload-staging.http.spec.ts` runs a real Nest HTTP listener on
loopback with an ephemeral test port. It uses the production lifecycle
interceptor, admission coordinator, secure Multer storage and exception filter.
The four small fixture routes represent the four existing upload classes with
distinct maximum reservations; their handlers replace only business persistence
and object storage. This is a staging-boundary proof, not a claim that the full
database-backed editorial flow or a production deployment passed.

The 16 scenarios cover:

- a partial source upload blocks montage, thumbnail and reference admissions
  even when another staging-root path on the same real filesystem is used;
  after disconnect, all four classes can upload again;
- a raw TCP disconnect while asynchronous admission is pending returns its
  reservation without creating a request directory or opening a writer;
- a raw TCP disconnect during an active file transfer keeps the reservation
  until the real output descriptor has closed (the fixture deliberately delays
  the close callback and verifies another HTTP upload is refused meanwhile);
- `ENOSPC`, `EDQUOT` and `EFBIG` at root creation, request-directory allocation,
  file open and file write: all twelve cases return exactly the generic HTTP
  503 envelope, leave no request residue or open descriptor, and admit the next
  upload after the injected fault is removed;
- Multer overflow remains HTTP 413 and releases the maximum reservation.

Only filesystem capacity values and the named fault/close boundaries are
injected. Files, file descriptors, multipart parsing and client/server sockets
are real; there are no provider credentials, database access or port 3000.

Run from a closed ADR-011 source fixture using Node `24.15.0` and pnpm `10.34.5`:

```sh
pnpm --filter @content-factory/api test -- test/upload-staging.http.spec.ts
pnpm --filter @content-factory/api lint
pnpm --filter @content-factory/api typecheck
pnpm --filter @content-factory/api test
API_UPLOAD_STAGING_SAFETY_BYTES=0 pnpm --filter @content-factory/api check:openapi
```

Unit runs in a source-only fixture additionally need explicit inert
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `REDIS_PASSWORD`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` and `POSTGRES_DB` fixture values, never a copied `.env`.
Non-test contract-export commands also require the explicit diagnostic safety
value above: the runtime intentionally does not default an `other` deployment's
safety budget. The same requirement applies to generated-client CI jobs.

`upload-staging-wiring.spec.ts` adds five checks against the actual production
module/controller graph: Projects owns and exports the sole lifecycle/coordinator
providers; Editorial and AI Context import those instead of redeclaring them;
each of the four actual handlers advertises its exact endpoint maximum and
places admission before Multer. This test must only be executed by the agent
inside the closed fixture, where the three protected application/repository
paths are committed blobs, not pending working-tree versions.

The frozen source tree `50b6015cb84eea05d3182d9cb0d7f0623858f4ab` is based on
`cb1289f831b1ed0d9051499c55553adfc73ea277` and contains only the 26 restored API
WIP paths plus the two new API test files. It does not incorporate the worker
WIP or protected pending edits. The fixture is
`/tmp/cf-api-upload-closed-20261014-vbNeKq`; its manifest contains 522 exact Git
blobs and records dependency reuse from the previously closed installation,
with 27 workspace/manifest/lock/schema boundaries compared through Git's normal
CRLF clean filter. No dependency was installed or upgraded.

The complete unit slice passed: 64 files, 308 tests, including all 16 HTTP and
five production-wiring scenarios. Strict zero-warning lint, TypeScript,
production TypeScript build and generated OpenAPI checks also passed. Unit JSON
evidence is `unit-results.json`, SHA-256
`4b8a49555295c5fd90976b7fca38d734095ea263f9f4ba3e9e56bc059b9ff973`;
`source-manifest.json` SHA-256 is
`f6d8236bfba1bc8d5d459e41fb251662790095c7f86402140f6292e30db90748`.
This documentation evidence update is later than that verified code tree;
source and test blobs are unchanged. Independent real-diff review remains
required. This proof does not approve image promotion or deployment.

Integration handoff: Main applied and the API owner verified the explicit
`API_UPLOAD_STAGING_SAFETY_BYTES: "0"` binding in the source-job environment of
`.github/workflows/release-gate.yml` for its non-test OpenAPI commands. The API
owner did not edit the orchestrator-owned workflow. Zero is only a diagnostic
fixture value, not an approved production disk reserve. Independent review and
Main's repeat API gate remain required before delivery.

## Independent review correction: exact private mode

Main's review found that the earlier `0o777` mask accepted special permission
bits despite the exact-`0700` contract. The API root check now uses `0o7777`,
matching the worker guard. Four additional cases reject existing `01700`,
`02700`, `04700` and combined `07700` roots before capacity probing; neither
asynchronous nor synchronous chmod, nor mkdir repair, may run.

The corrected code was frozen as tree
`7323364bd8c5dd5e4bec2ba0aa1c3c88d8b8fda3` in
`/tmp/cf-api-upload-closed-20261014-xIy9xf`. The full API batch passed again:
64 files, 312 tests, including all HTTP and wiring checks. Strict lint,
TypeScript, build and both OpenAPI checks are rerun on this corrected tree;
the review correction does not change the public API contract.

The new `unit-results.json` SHA-256 is
`de3e5b5e9b7d66a4d6a956e72424ffb8792f7da0eb4711cf7dc09d858ed72e0b`;
`source-manifest.json` SHA-256 is
`3950360e4f0fc515a0390b62ea814ce3d143c1d8b7c2e1b6b3191e981c6f3ac9`.
This follow-up documentation is later than the corrected code snapshot.
Independent reviewer reproduction is still required before delivery.

## Native diagnostic API artifact

The corrected API tree plus the documentation follow-up was captured in the
unattached candidate commit `a9102e29cf61a3b8fd24e5d385ba7a93677c3b08`
(tree `1a8fcdc6168c52353a53c6b47aec679ed24cae4a`); no working branch or shared
index was updated. The API exporter produced 352 allowlisted committed files
at `tmp/api-context-XsyXMs`. Its embedded provenance and the Dockerfile's
content/closure assertions passed. No dependency or image pin was changed.

The final locally loaded native `linux/amd64` image is
`content-factory-api:upload-capacity-a9102e2-native`, image index
`sha256:9735129b8c2ead343fd7c4185464957a6f468bdca3bdabab3a48ba474b1be95b`.
The OCI archive's actual platform manifest is
`sha256:260a8e25facc9029536fdeec6ee8cf7a33ed9ebce16bea99a0377e043120240d`.
BuildKit automatic Git detection was disabled for the final cached rebuild:
the exported directory lives below the working checkout and would otherwise
misreport the parent branch SHA. The explicit `SOURCE_REVISION`, OCI label and
352-file embedded provenance retain the exact candidate binding.

Evidence is under `tmp/api-native-capacity-20261014-qFc8W4/`:

- `native-proof.json`: final image identity, embedded provenance, smoke and
  checksums;
- `api-native-final-linux-amd64.oci.tar`: SHA-256
  `f17f02daa33513cfa91526ffa3b0b9933a0ec8a563642bdb252597dbef6095b6`;
- `build-native-final-metadata.json`: SHA-256
  `0e76737fc431a20f0dc2320558e9f8e52e97a2006f0bc7d239588205ccfc03ec`;
- `native-smoke.mjs` and `capture-proof.mjs`: reproducible isolated proof.

The final-image smoke passed as UID 1000 on Node 24.15.0 with no network, no
published ports, a read-only root, dropped capabilities, no-new-privileges and
a bounded diagnostic `0700` tmpfs. It verified all four special-bit refusals
without repair, actual multipart HTTP/write/read/checksum with `0600` file
permissions, 413 overflow, successful subsequent admission and zero residue.
The HTTP proof uses a minimal controller around the compiled production upload
components; it does not replace the full database-backed manual pipeline.
Main owns the separate combined pipeline and namespace
`cf-worker-capacity-20261014`; the API owner did not access that namespace.
The earlier unsuffixed image tag is superseded for handoff. No artifact scan
or release promotion was claimed; independent review and all release gates
remain required.

## Native PCRE2 successor diagnostic follow-up

Main's architect-approved PCRE2 maintenance was captured as unattached candidate
`83f9d4ba727546450a04511b2a24773d279de426`, tree
`51fb1f51817a6f2cf56933e4c9087c75991b7605`. Its only changed path relative to
`a9102e29cf61a3b8fd24e5d385ba7a93677c3b08` is
`infrastructure/api/Dockerfile`: the exact PCRE2 install pin and assertion change
from `10.42-1+deb12u1` to `10.42-1+deb12u2`. API application/test/schema blobs are
identical, so the existing 312-test proof remains the source baseline rather
than claiming a redundant new application test run.

Both native images built with `BUILDX_GIT_INFO=0`, unchanged remaining pins and
the exact 352-file exported context `tmp/api-context-OOgogf`:

- `content-factory-api:pcre2-u2-83f9d4b`, image index
  `sha256:c3b4dfed56fe6d98a59639b6c68c3ab051bfb34a440205b74ac83e453500ef84`;
- `content-factory-api-migrate:pcre2-u2-83f9d4b`, image index
  `sha256:1db894891c5bbfcaaba2c63012deaf5b51d5a8500202bd154f976c17c0183bd4`.

Evidence and OCI archives are in `tmp/api-pcre2-native-20261014-PLpGlY`.
`candidate-proof.json` proves source identity; `inventory-proof.json` records
every package comparison and preserves a nonzero failure for the originally
specified older migration baseline, not an exception or waived gate.

The API inventory has 88 packages, no additions/removals, and only PCRE2
`u1 -> u2` relative to `9735129b8c2e...`. The migration inventory has 90
packages and no additions/removals. The requested migration reference
`83bd3df51212...` predates the existing five-package maintenance: comparison
against it changes libgcrypt20, libgnutls30, liblzma5, PCRE2 and tzdata, so the
requested one-package comparison fails. A supplemental comparison against the
existing patched `content-factory-api-migrate:security-proof-61eb281`
(`sha256:7be403d21bfe969be27b3586ddb593278f3590ad841a49ea92c2f384c55748ac`)
passes with PCRE2 alone `u1 -> u2`. Schema/migration inputs match that patched
baseline exactly. Main explicitly accepted that corrected baseline after
checking the preceding hardening record in `api-runtime-hardening.md:48-71`:
the `61eb281...` revision and `7be403...` image are the actual preceding
maintained migrate artifact. This is a baseline-selection correction, not an
exception or a relaxed package gate. The original `inventory-proof.json` remains
unchanged with status FAIL and is classified as a baseline-selection error.
The separate `final-inventory-proof.json` independently rechecks the saved
complete inventories against the accepted references and passes for both
images: only PCRE2 `u1 -> u2`, with no added or removed packages. Migrate's
OpenSSL and libssl3 remain exactly `3.0.22-1~deb12u1`. No image rebuild or API
application change was needed for this factual correction.

`native-staging-proof.json` records successful isolated multipart/0700/0600,
special-bit refusal, 413 and subsequent clean admission in the new API image.
`migration-proof.json` records fresh application of all 45 canonical migrations,
matching checksums, and an unchanged repeat with no pending migrations. The
separate `cf-api-pcre2-20261014-plpgly` PostgreSQL/network fixture had no host
ports, used only inert credentials and ephemeral tmpfs data, and was removed
after verification. Main's namespace was not accessed. Artifact scans,
independent review and promotion gates are not implied by these diagnostics.

### Final attested artifacts and fresh scans

The original simultaneous Docker/OCI exports lacked attestation in the OCI
archive, so the unchanged scanner correctly refused the initial API archive
before scanning. Those original archives and the failure are preserved. The
same exact `83f9d4ba727546450a04511b2a24773d279de426` candidate was re-exported
from cache with `BUILDX_GIT_INFO=0` and explicit `--provenance=mode=max`, without
source/pin changes or manual OCI edits. The final unique tags are:

- `content-factory-api:pcre2-u2-83f9d4b-attested`, image index
  `sha256:d31b01339408908e25e2408fcbcffde29f9042cc95c0c64192d973151f918783`;
- `content-factory-api-migrate:pcre2-u2-83f9d4b-attested`, image index
  `sha256:0c427a236569d07d528e70a61e9ef092290601939b89432ac8918cb789406281`.

Final archives are `api-runtime-attested-final-linux-amd64.oci.tar` and
`api-migrate-attested-final-linux-amd64.oci.tar` in the same PCRE2 evidence
directory. Both contain validated BuildKit attestations. Their native platform
manifest/config/layers match the earlier runtime-tested images exactly:
API `sha256:502055457bfdb868380990e08d7795a58005143642eec600b96b25616710034a`,
migrate `sha256:fd3784d584a87763f5740321b4fb89488c7e9c15a12a3b641dd8d9bd4abdeb94`.
The earlier corrected migrate comparison against `7be403...` remains accepted;
the original `83bd...` baseline-selection FAIL remains unchanged.

After checking DB metadata, refresh proof and matching file hashes, the pinned
offline all-severity scanners ran sequentially using the read-only cache root
`tmp/web-edge-db-4kv0cK` (not its `/db` child). DB `UpdatedAt` was
`2026-10-14T07:11:52.271767627Z`, well within the required 24-hour window at
both scans. No exception, severity pre-filter or policy change was used.

- API: `tmp/artifact-scan-ngGmjo`, 242 total findings, 159 non-LOW, DENY.
- Migrate: `tmp/artifact-scan-Cqaw0A`, 255 total findings, 168 non-LOW, DENY.

Each directory retains `sbom.spdx.json`, the complete `trivy.json`, and
digest-bound `evidence.json`. The combined
`tmp/api-pcre2-native-20261014-PLpGlY/artifact-scans-summary.json` contains all
archive/SBOM/report/evidence/build-metadata hashes, pinned tool identities,
severity counts, DB binding, exact scan times and sequential-order proof.
Its SHA-256 is
`994aabc1f2d205422b3f15383a4f23a85ad6cacbfeb3e4847b2d9297393c6e64`.
Both scanner gates returned exit code 1. Production promotion/deployment remain
blocked; a functional smoke or accepted package comparison does not waive
these findings.

### Independent delivery review

The corrected source slice was independently reproduced: 312 tests in 64 files,
plain zero-warning lint, strict types, build and generated OpenAPI consistency
passed, with no remaining source correctness findings. The reviewer separately
reproduced both complete native package inventories against the corrected
preceding immutable references. Protected pending API files were never used;
the closed fixture contained only their committed baseline blobs.

Before checkpoint staging, formatting normalized restored CRLF files to LF;
Git-cleaned code blobs still match the reviewed immutable candidate exactly.
No additional application change or dependency upgrade is hidden in that
normalization. The current complete and production-classified source audits
were repeated separately and now each deny at ten advisories; this source
correctness review is not a clean dependency gate or production approval.
