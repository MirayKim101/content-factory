# WSL manual-cut smoke — 2026-09-09

Status: normal API/browser scenario passed. This report does not establish final
acceptance of crash recovery or the complete MVP; independent recovery review
is tracked separately.

## Fixture and runtime

The orchestrator used a synthetic 6-second H.264/AAC MP4, 320×180, 253874 bytes,
SHA-256 `97080918bcab8359d229439482f1ea43f0a2bbb80d14e59c44f3a143af2744d3`.
Its exact source authorization was already explicitly cleared in local project
`e6a8313b-273c-4578-832a-afaa03679cb7`.

The successful run used worker image
`sha256:2c7e2df8656bd63da3ed195891df1820d1b15ebef4a34876b1c4f5247a1c5c09`,
Node 24.15.0, FFmpeg 5.1.9, UID 1000, one heavy slot. API was on loopback port
3001 and Nuxt on 3000. The long-running Nuxt development process required a
restart after the dependency installation changed pnpm paths.

Final normal browser scenario was repeated after the reviewed fixes on image
`sha256:613426ce265362aa076f69df71114de8f266d1358d0c5548c426f8abb1b36369`
and the rebuilt API. Job `dc6abaa6-e3b2-45f2-ad41-1bd67cdb2dd6` passed the same
player/seek/create/reload/download assertions with no JavaScript errors.
The local browser evidence/screenshot now describe this latest repetition.

## Initial failure and correction

The first real run exhausted three attempts for each valid cut. The existing
MinIO policy allowed only `sources/*`, while cut output keys use
`projects/*/cuts/*`. Upload and cleanup were denied. The old error classifier
reported upload failure as `MEDIA_PROCESSING_FAILED`, obscuring the cause.

Infrastructure now grants the required object actions only on the cut prefix
in the owned bucket, retaining the separate source rule. Reprovisioning only
`minio-init` repaired access. DevOps verified cut-prefix put/stat/delete succeeds
and a write to a non-cut project prefix remains denied. The running reconciler
completed all six outstanding output cleanups. Failed job records were retained.
Storage-specific classification was subsequently added by the implementer.

## Independent successful checks

| Scenario                               | Observed result                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Source HEAD                            | 200, correct length, empty response body                                                               |
| Prefix/suffix byte ranges              | 206 with exact requested bytes                                                                         |
| Past-end, multipart or malformed range | 416 and `Content-Range: bytes */253874`                                                                |
| Cut 500–2000 ms                        | SUCCEEDED, one attempt, downloaded duration 1500 ms                                                    |
| Cut 2500–5000 ms                       | SUCCEEDED, one attempt, downloaded duration 2500 ms                                                    |
| Same idempotency key and range         | Same job ID, 202                                                                                       |
| Same key with changed range            | 409 IDEMPOTENCY_CONFLICT                                                                               |
| Cut 0–9000 ms                          | FAILED_FINAL, one attempt, CUT_OUT_OF_BOUNDS, no artifact                                              |
| Successful downloads                   | MP4 attachment; bytes and SHA-256 match stored artifact                                                |
| Download byte range                    | 206 and bytes equal the full-download prefix                                                           |
| Browser                                | Player metadata, seek-to-start button, create, polling, reload and download pass; no JavaScript errors |

Successful REST jobs:

- `e78f2cf4-8d6b-4876-9613-3ea9fe0cd8ec`: 84766 bytes, SHA-256
  `b854b57d7c89449d0bd9fcc964b013e3e5abad46e75f37239311e2b936b2da8b`.
- `4a67f349-e7e3-4695-a6a5-004cfecf84d2`: 150800 bytes, SHA-256
  `a939e6f8d85a21c088b905e5b4e35f491cd133a67b20d76edd70cb20b5d1dc05`.

Browser job `b3d87f2c-fece-40b3-95b6-a8b484d89421` used 750–2250 ms and produced
a 1500 ms H.264/AAC result. Downloaded durations/codecs were independently
measured by FFprobe in a read-only, network-disabled container using stdin.

## Local reproducible evidence

Ignored files under `tmp/browser-smoke/` contain `cut-api-smoke.cjs`,
`cut-browser-smoke.cjs`, `cut-api-evidence.json`, `cut-browser-evidence.json`,
the screenshot and downloaded MP4 files. First-failure logs/state are under
`tmp/recovery/cut-first-runtime-*`. These files are local evidence, not portable
repository fixtures. The durable verification protocol is
`RECOVERY-MANUAL-CUT-VERIFICATION.md`.

Re-running the local API script creates three new synthetic jobs. The browser
script reuses the cleared fixture and creates one new job. Run them only with
the expected API/worker active and outside the controlled crash-test window.

```sh
node tmp/browser-smoke/cut-api-smoke.cjs
LD_LIBRARY_PATH="$PWD/tmp/browser-smoke/sysroot/usr/lib/x86_64-linux-gnu" \
PLAYWRIGHT_BROWSERS_PATH="$PWD/tmp/browser-smoke/browsers" \
node tmp/browser-smoke/cut-browser-smoke.cjs
```

No actual process-crash or Redis-loss result is asserted by these normal-path
checks. HEAD wire behavior alone also does not prove absence of storage I/O;
that requirement needs focused route/adapter verification.
