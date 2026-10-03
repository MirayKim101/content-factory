# Worker runtime hardening — immutable baseline evidence

Status: baseline and hardened OCI scanned; runtime/recovery batch passed;
security gate still denies promotion. No production deployment approved.

Date: 2026-10-03

## Scope

This baseline uses the exact committed worker source revision
`e5115c875b22aa23b2e0aa532e5ed48c6548f966`. It does not include the mutable
working tree and does not change the pinned Node, FFmpeg, font, application
source, dependency graph or runtime configuration.

The original baseline export did not load an image or alter services. The later
hardening candidate was loaded only into the local daemon and tested in owned,
internal fake-credential `cf-api-proof-20261003`. Nothing was pushed to an image
registry or deployed. Working services and port 3000 were not involved.

## Closed Git source context

The committed `scripts/export-worker-build-context.mjs` helper materialized the
context from the Git object database:

- commit: `e5115c875b22aa23b2e0aa532e5ed48c6548f966`;
- tree: `0b3dfb1b8612c44ad3ace7af21accd7f985c8927`;
- selected committed regular files: `93`;
- context directory: `tmp/worker-context-BRQYj5`;
- context export record:
  `tmp/worker-runtime-baseline-e5115c875b22/context-export.json`;
- `build-provenance.json` SHA-256:
  `e1c3d0542339b320027e5e030d82bf86f81cb01cf9e28a7a5a31dd665c1a275c`;
- worker Dockerfile SHA-256:
  `29c855303288a7b43e37e2f95e3dd2b1a01b9fb83c7c77268210feb8562e85a5`;
- `pnpm-lock.yaml` SHA-256:
  `e4b8fa6944d0e72303c4db4a0c41bf4e876cf8826c85d824485a5084eaf3987b`;
- root `package.json` SHA-256:
  `9669884dad111ba2d8344d77b9d9dc912c56489895b957a3e41b681a376e0c36`;
- `pnpm-workspace.yaml` SHA-256:
  `e345eeec9177d54e796f3ff8652b69ab37ab43ad3d5603ae60f174053db7e851`.

The exporter and artifact-policy test suite passed all `10/10` tests before
the build, including exact-revision, regular-file-only, protected-path,
severity and scanner-isolation checks.

## Named baseline OCI

The primary baseline was built for only `linux/amd64` with
`--provenance=mode=max`, using the Dockerfile inside the closed context and
`SOURCE_REVISION` equal to the exact commit above:

- archive:
  `tmp/worker-runtime-baseline-e5115c875b22/worker-linux-amd64.oci.tar`;
- archive size: `258375680` bytes;
- archive SHA-256:
  `848d54e4b932dde4d90f628b66dc6b482a59d1da7996e3aecb97164d2bb1e129`;
- leaf manifest:
  `sha256:284234df76f382080f6f4acfa696bd3487dbddfd3ca5e388dd474ea2569da2fc`;
- leaf config:
  `sha256:c27a4f15b68c32cc2375345b2ffd31b35c6ec2965afe02aafec8dc1755ec5c30`;
- provenance attestation manifest:
  `sha256:16b97731e3e6e5cb2a7fd8395e6eb5944d31a14cc4722eb5148afaee8898a677`;
- attestation subject: the exact leaf manifest above;
- OCI label source revision: the exact `e5115c8...` commit;
- OCI promotion label: `blocked-until-all-release-gates-pass`.

The helper validated OCI descriptors, config/platform/revision labels,
attestation binding and every layer digest before attempting the offline scan.
The largest gzip layer is:

- digest:
  `sha256:470454a32a6c632a9cf17bbc4ffc237c168eb8856b24f350bc36758200d61481`;
- compressed size: `174581264` bytes;
- media type: `application/vnd.oci.image.layer.v1.tar+gzip`.

Build assertions retained the committed production-only worker closure, direct
`ioredis@5.11.1`, native Node startup and controlled exit `78` when required
runtime configuration is absent. This build evidence does not replace the
pending artifact scan or runtime functional smoke.

## Offline scanner inputs

The approved task-owned database was used without refresh or mutation:

- cache: `tmp/trivy-db-connected-EbhFAj`;
- schema: `2`;
- `UpdatedAt`: `2026-10-03T07:01:46.027466673Z`;
- `metadata.json` SHA-256:
  `b35148159c0541a289d09cbc3c0cdc276424f34ec31fca024db02836c5779adc`;
- `trivy.db` SHA-256:
  `60b704c31056edb9b6c2ccb271c3837f4ecca531d2da6d79663136f53ba20027`;
- Trivy:
  `aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`;
- Syft:
  `anchore/syft:v1.54.0@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c`.

Both pinned scanner images were already present under their exact repository
digests. The committed helper was invoked with the named OCI archive, this
cache and the exact full source commit.

## Original fail-closed helper blocker

The scanner helper stopped before either Syft or Trivy ran. Its generic
`execute()` output writer has a `128 MiB` limit intended for scanner output,
but the helper also uses that writer while materializing each already-validated
OCI blob into a layout. The `174581264`-byte worker dependency layer therefore
raised `AssertionError: Scanner output exceeded 128 MiB`.

The partial helper directory is `tmp/artifact-scan-sn64r1`. It contains only a
partial OCI layout; it contains no SBOM, Trivy report or final `evidence.json`.
Consequently:

- vulnerability findings: **not produced**;
- `artifactGatePassed`: **not evaluated / fail-closed**;
- `promotionApproved`: **false**;
- no claim of a clean or vulnerable worker artifact may be derived from this
  failed attempt.

As a bounded diagnostic, the same cached build was exported with OCI zstd level
22 and forced compression. It preserved the same leaf config digest, but its
largest layer remained `147910688` bytes and still exceeded the helper limit:

- archive:
  `tmp/worker-runtime-baseline-e5115c875b22/worker-linux-amd64-zstd.oci.tar`;
- archive SHA-256:
  `bc367d6e3b62bc88ea0695b2b010560d12f91d48c6dc624f3b1438d9f31de3f7`;
- leaf manifest:
  `sha256:0e1838eb3d7859a1c60b1cef1cf34198595ddebd553332024a92a6704ab94558`;
- leaf config:
  `sha256:c27a4f15b68c32cc2375345b2ffd31b35c6ec2965afe02aafec8dc1755ec5c30`;
- largest layer:
  `sha256:caee4f1b02630f4cb4297d839a6fa0803e33840d899da7975cf7acfa0b5c84b1`,
  `147910688` bytes, `application/vnd.oci.image.layer.v1.tar+zstd`.

Compression is therefore not a valid workaround. Direct Trivy/Syft execution,
severity filtering, a different DB, archive rewriting or bypassing the Main
helper was not used.

## Original continuation criteria (completed below)

Main must separately review and correct the helper so validated OCI blob
materialization is bounded by the descriptor size already checked by
`inspectOciArchive` (currently each layer must be below `2 GiB`), while the
`128 MiB` cap remains enforced for scanner JSON output. The correction requires
tests proving both a layer larger than `128 MiB` can be materialized and scanner
output larger than `128 MiB` still fails closed.

After that independent helper checkpoint, rerun the committed helper against
the existing primary gzip archive and the still-fresh approved DB, or refresh
the DB through the separately owned connected step if it has become older than
24 hours. Acceptance requires:

1. digest-bound SPDX SBOM and Trivy JSON for the exact leaf config;
2. recorded archive, manifest, config, DB, report and SBOM SHA-256 values;
3. complete all-severity inventory with no pre-filter or suppression;
4. `UNKNOWN`, missing/unclassified, `MEDIUM`, `HIGH` and `CRITICAL` findings
   blocking fail-closed; only recognized literal `LOW` may pass artifact policy;
5. independent review of the helper correction and the real baseline evidence.

These original criteria did not themselves authorize remediation. After the
baseline scan completed, the architect authorized the bounded final-only
package-manager removal described below.

## Completed correction and full baseline scan

The corrected helper binds OCI blob output to its validated descriptor size
(strictly below 2 GiB) and SHA-256. The scanner JSON cap remains 128 MiB.
Partial file writes are handled explicitly. Four tests cover a valid 129 MiB
blob, oversized JSON rejection, short/oversized/corrupt blobs, invalid
descriptors and partial writes. The related helper batch passes 25 tests.
Scanner pins, read-only inputs, network isolation and severity policy are
unchanged; only recognized literal LOW findings may pass.

Actual baseline full scan used the above archive and fresh DB:

- output: `tmp/artifact-scan-wNSzOZ`;
- report SHA-256:
  `e37c6a74d9f549823cf3add75ddf8c1bdf1071667e4be877f820903fc11eeb32`;
- SPDX SBOM SHA-256:
  `f5881ef364e96730125bfa78e96865d8185f97af7a635d9ca510c3c6a0dea467`;
- all 961 records: LOW 218, MEDIUM 431, HIGH 260, CRITICAL 13, UNKNOWN 39;
- **743 blocking records:** Debian 717 and Node package 26; promotion denied.

## Final-only package-manager removal

Candidate `6c20ffab25653c198bb34734aba620899fd27a01` changes only the worker
Dockerfile relative to public `853e60b`. Its exact Git context contains 93 files
at `tmp/worker-context-Flndca`. Node 24.15.0, Bookworm, FFmpeg 5.1.9, fonts,
native production dependencies and application code remain unchanged. Only
known base-image global npm/Corepack/Yarn trees and shims are removed; dangling
symlinks are rejected. Build-stage package managers remain available.

Named `linux/amd64` OCI with maximum provenance:

- archive: `tmp/worker-hardening-6c20ffab/worker-linux-amd64.oci.tar`;
- archive SHA-256:
  `d3aaa0861bdada2f0e1e9f78ec5575a856c0bc36bbf91757a7e204e43c55cd54`;
- leaf manifest:
  `sha256:87a0975456d896cbc4f71a7a9c71768927e1f4e9e5889dd9e087530297341d47`;
- leaf config:
  `sha256:c995a56f205af6cccaa24cbb40dea2266f7761766e58701fa181e7fca4bea2eb`;
- local diagnostic image: `content-factory-worker:hardening-proof-6c20ffa`;
- full scan output: `tmp/artifact-scan-m42fTi`;
- report SHA-256:
  `c6977f30b4146144a610cff3e61748320e58367363fe06be57946485ef6357a8`;
- SPDX SBOM SHA-256:
  `41efa11eab275c1013845332959bac06562136d811ec5093f04a7ecc14a250f3`;
- all 934 records: LOW 217, MEDIUM 418, HIGH 248, CRITICAL 12, UNKNOWN 39;
- **717 blocking Debian records remain; promotion is denied.** These are
  finding records, not unique CVEs. Removing 26 Node records does not establish
  a clean artifact or justify ignoring residual OS/FFmpeg vulnerabilities.

Read-only, network-disabled comparison retained at
`tmp/worker-hardening-6c20ffab/inventory-proof.json` confirms identical Node,
FFmpeg/ffprobe/font hashes, all 288 installed OS packages and all 66 native
production packages. UID remains 1000; missing configuration produces
controlled exit 78. No application graph was trimmed to hide findings.

## Combined runtime and recovery acceptance

With diagnostic API `3320af2` and this exact worker, the large batch proved:

1. manual upload/rights, v3 cut, READY, checksum download and idempotent replay;
2. real loss of the disposable Redis queue, recovered to one READY artifact;
3. SIGKILL during observed PROCESSING, restart to attempt 2 and one artifact
   with the identical result checksum;
4. container-valid corrupt media yields `FFMPEG_CUT_FAILED`, no ready result.

Normal output: 3889 bytes, SHA-256
`96d208d25724a25649cddea88236b1e42037cbef25fddd80725a6db5149a6b70`.
Recovered/restarted output: 21547 bytes, SHA-256
`b1cfaf517c78c179135d7510f508ef35d7388ecffb45fb7ac25f68b3586c3753`.
Private evidence: `tmp/worker-hardening-6c20ffab/media-evidence.json`, SHA-256
`f8d09ffa343168c59bf971e675cefe2b3dc4acb4f5ecbe81ca5cbd2773341aa5`.
This tiny fake-credential diagnostic does not certify production disk capacity
or every other worker role.

## Rollback and remaining gates

Restore the prior v3-capable `e5115c8` diagnostic worker after quiescing jobs;
no schema or recipe rollback is required. Keep v3-capable workers for already
admitted v3 jobs. Production stays blocked by the 717 artifact records and the
separate two-high source gate. OS/FFmpeg replacement needs a material ADR and
independently reviewed scan, compatibility, output, resource and recovery
evidence. No deployment, provider admission or security exception follows.

## Follow-up: exactly five Bookworm package updates

The architect approved a separate final-only patch, without replacing the
Node/OS/FFmpeg baseline. Candidate
`5e336496db144aa23aa29a818c62c75fcbfef86b` was exported as 93 exact Git blobs
into `tmp/worker-context-5knW9D`. The new Docker build asserts a complete
before/after package inventory: only these existing packages may change;
additions, removals or other upgrades fail the build:

- `libgcrypt20=1.10.1-3+deb12u1`;
- `libgnutls30=3.7.9-2+deb12u7`;
- `liblzma5=5.4.1-1+deb12u2`;
- `libpcre2-8-0=10.42-1+deb12u1`;
- `tzdata=2026c-0+deb12u1`.

These versions were checked against official Debian Bookworm package pages:
[libgcrypt20](https://packages.debian.org/bookworm/libgcrypt20),
[libgnutls30](https://packages.debian.org/bookworm/libgnutls30),
[liblzma5](https://packages.debian.org/bookworm/liblzma5),
[libpcre2](https://packages.debian.org/bookworm/libpcre2-8-0),
[tzdata](https://packages.debian.org/bookworm/tzdata).

Actual immutable `linux/amd64` maximum-provenance artifact:

- local image: `content-factory-worker:os-proof-5e33649`;
- archive: `tmp/worker-os-hardening-5e336496/worker-linux-amd64.oci.tar`;
- archive SHA-256:
  `5bcfa7936e1d868bbfbd1f30bd8f1098a62898ba545aac4be76ae13616341efd`;
- manifest:
  `sha256:00247c29017f4e1836bfdb106ce72321bfcc4ec31c823ababce2c05326bed396`;
- config:
  `sha256:db6bd64adb3774b2900663d8d823fdc80dd0c25f3cb84d3c97bcea82bb71d1f3`;
- full scan: `tmp/artifact-scan-hgBPz4`, using the same fresh DB and pins;
- report SHA-256:
  `f0e0c9089d5052f3aa60f3f55de2e395c6fcf7395a9c28714e54785853797547`;
- SBOM SHA-256:
  `da59dab3f4f3b1f89b62b41ea7cd680ca26ba5ac92c20d5a75c7872b327f256f`;
- LOW 216, MEDIUM 407, HIGH 242, CRITICAL 10, UNKNOWN 36;
- **695 blocking records remain**, down from 717. Promotion still denied.

Independent of build assertions, read-only/network-disabled comparison proves
exactly the five allowed package version changes, no additions/removals among
288 packages, identical 66 native production packages and unchanged Node,
FFmpeg/ffprobe/font hashes. Configuration failure remains exit 78. Inventory
proof: `tmp/worker-os-hardening-5e336496/inventory-proof.json`, SHA-256
`f7b7ee28b42b19875a1e42a93b0f5d5a64b4122436ed914519f29bb4ee7e0cc9`.

The complete real-media batch was repeated against this image: normal/replay,
queue loss, SIGKILL while PROCESSING, attempt 2 with one artifact, and controlled
corrupt-media failure all passed. Both result sizes/checksums match those above.
Proof: `tmp/worker-os-hardening-5e336496/media-evidence.json`, SHA-256
`bbcce763541874f4c99438bf6216b60a3446076df2cf05d202f0fa713f8a300a`.
An initial diagnostic command used the wrong healthcheck path and stopped after
normal acceptance; the actual installed healthcheck at
`/usr/local/bin/content-factory-media-worker-healthcheck.mjs` then passed before
the remaining recovery/failure phases ran. This was not an application defect.

Rollback remains the prior v3-capable immutable worker after drain, without
schema/data changes. The security deny and production prerequisites remain;
no replacement distribution, package override or provider admission is approved.
