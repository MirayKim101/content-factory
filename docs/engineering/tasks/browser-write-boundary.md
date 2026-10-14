# Browser-write boundary — bounded acceptance

Status: implementation in progress; production approval is not implied.

## Authority and scope

ADR-001/011 retain a private same-origin SPA and independent REST API, without
application JWT, public registration or CORS. Architect review on 2026-10-14
approved explicit Origin/Fetch Metadata protection as ordinary completion of
that boundary. This is not authentication and does not replace private access,
source/asset authorization or protection against same-origin malicious code.

References checked before implementation:
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/).

## Contract

- GET/HEAD/OPTIONS are exempt from this unsafe-method guard, preserving health,
  download and Range. This exemption does not prove business side-effect
  freedom: the known default-off TikTok creator-info GET can refresh OAuth;
  remediation is tracked in `tiktok-credential-rotation-gap.md`.
- Every other method is checked before body parsing, Multer and business work.
- `API_BROWSER_ORIGINS` is a comma-separated explicit list of at most 32
  HTTP(S) origins (scheme, host, effective port), at most 4096 characters.
  No wildcard, credentials, opaque null, path, query, fragment or empty entry.
  Duplicate canonical origins are configuration errors. Missing/empty setting
  allows no browser writes, rather than inferring a production domain.
- Exactly one valid Origin must match that list. Cross-site, none, unknown or
  duplicate Sec-Fetch-Site metadata is denied even with an allowed Origin.
  `same-site` alone never grants trust. Host, forwarded headers and Referer do
  not supply a fallback. Express trust proxy is explicitly false.
- Intentional native clients without Origin, Referer or browser Sec-Fetch-* headers
  must send exactly `X-Content-Factory-Client: native-v1`. This is a browser
  forgery barrier, not a credential. Present invalid Origin/metadata cannot be
  bypassed with that header. A single exact `Sec-Fetch-Mode: cors` is permitted
  for the real Node fetch transport, which supplies it automatically; Site,
  Dest, User, unknown or duplicate fields do not gain a native exception.
  No browser adapter adds the native marker and CORS stays disabled.
- Denial is safe JSON 403 `BROWSER_WRITE_FORBIDDEN`, no-store, without reflecting
  untrusted origins or secrets. No provider callback exemption is introduced;
  future callbacks need separately reviewed route-specific signature/replay
  protection and remain default-off.
- SPA framing protection is a separate edge change; no broad script CSP or
  COOP change is bundled into this API slice.

## Required evidence

The hosted isolated-media runner explicitly exports and read-only mounts the
new native request fixture as well as its importing suite. The runtime API
context intentionally excludes test files, so the helper cannot be assumed
present in a build image. Preparation tests verify this exact bounded mount.

Configuration canonicalization/negative cases; actual Nest/Express JSON and
multipart positives and negatives, raw duplicate headers, spoofed forwarding,
cross-site form submissions, missing/opaque/malformed origins, sibling domains
and alternate ports. Denied requests must precede body parsing, upload staging
and handler/DB/object/queue effects. Verify reads/health/Range and CORS remain
unchanged, native diagnostic clients obey the explicit contract, and genuine
same-origin browser JSON/multipart writes succeed through the private edge.
Run relevant large API/contracts/integration gates, build native artifact and
repeat smoke/recovery where affected, followed by independent real-diff review.

## Configuration and rollback

Local example origins are only documented examples, never inferred defaults.
The real deployment allowlist requires actual owner-selected gateway/domain
facts. No domain, TLS, public ingress or production settings are provisioned.
Configure approved origins before replacing a running API. Existing native
automation must adopt the marker; do not globally disable the guard to restore
old clients. On rollback stop admission, preserve data and compatible workers,
and retain private access; an old binary without the boundary is not a secure
production fallback. Existing deployments are not restarted by editing source.

## Current diagnostic evidence — 2026-10-14

The published preceding checkpoint is `464aeb9c54b7c4b1341d9b7533cedbd715f87c96`;
remote SHA was confirmed. Hosted run `38576934260` passed source formatting,
lint/types/unit/contracts/builds, all container preparation, fresh migration/
recovery and isolated media integration. Only its two mandatory dependency
audit steps failed; this does not certify the new guard or DevTools source.

Frozen combined diagnostic source `07a5f56ca0c4c6a3e4c8cc971c37768d7a41425d`,
tree `4aca2a49e10391cc83a05041916268645b2f354e`, combines the guard and compatible
DevTools 3.4.3 lock. API lint/strict types/build, 375 tests/66 files, deterministic
OpenAPI and generated-client checks pass. Dependency links reuse the separately
verified cold 930-package strict install with an identical frozen lock; this
API batch does not claim another cold install. Main's gate log summary is
`/tmp/cf-browser-write-proof-FSsIZq/gates.json`, SHA256
`994d792f127f45ea7f6f881a751e59e0f14226f95377d7bb3a52ea35a4a89b16`.

Initial proof history is retained: a Supertest array-overload TypeScript error
was corrected; the real Node fetch regression first failed 403 under the
over-strict no-metadata rule. That preserved negative control is
`/tmp/cf-browser-write-proof-DNlZCi/native-transport-negative-control.log`.
The exact single-Mode compatibility exception and empty-userinfo parser
rejection were independently checked before the final source batch. The marker
never grants an exception to hostile/present Origin or Site metadata.

Three new max-provenance native images use only the exact frozen source:

| Role    | OCI index SHA256                                                   |
| ------- | ------------------------------------------------------------------ |
| API     | `14e8b2cb411bfbf870b4b169b8c8c8a1b8e6b5a8b29ca7f71ae04ece9e67e107` |
| Migrate | `fb6f0fc0fedf75a3a03059412f233c1654a9b51e035a72bd34272e559b22b2fa` |
| Worker  | `c9b16b454da1a0a86713dad79c39fd025777aeca712fecc3759e11d710259e0d` |

Complete inventories match the preceding e17 native images exactly: 88/90/288
OS packages and 180/135/66 JS packages respectively; Node, FFmpeg/ffprobe/font
hashes are unchanged. Proof `tmp/browser-write-native-vWOCMb/inventory-proof.json`,
SHA256 `99e56b03a5ed47cd09c1d00aa6bc73015b1578c52535ac1e420e87329821fd53`.

Fresh isolated `cf-origin-07a5-20261014` has no published host ports. A separate
diagnostic overlay explicitly allows only its browser's actual loopback origin
`http://127.0.0.1:8080`; this is not a production gateway selection. Fresh/repeat
45 canonical migrations, actual queue-disabled API smoke, then queue-enabled
upload/manual source attestation/probe/cut/replay, Redis queue loss, SIGKILL 137,
checksum/Range 206/416, 413/415 and corrupt-media failure/cleanup pass. Recovered
attempts are 1/1/2 with one artifact per cut. Own Redis clearing is validated by
exact namespace labels and queue-key allowlist; other namespaces are untouched.
Proof `tmp/browser-write-native-vWOCMb/runtime-proof.json`, SHA256
`2a9bae9f53aa01a037dd1b54358f0775f650cc26443a47578b718d7c87437093`.

Independent source/native review is CLEAN: 375 source tests and fifteen real
compiled-guard HTTP checks were reproduced, all three native inventories
repeated, and OCI/provenance/SBOM/scan bindings checked. Disruptive recovery
scripts/logs were inspected, not rerun in Main's namespace. Handoff:
`/tmp/cf-guard-native-review-20261014-pJpFdQ/HANDOFF.md`.

All five real HTTP/PostgreSQL/Redis/MinIO integration suites pass: 41/41,
zero skipped. The independent reviewer repeated all 41 in another fresh
namespace. Both runs verified fresh/repeat 45 canonical migrations and removed
only their own synthetic data/containers/networks. Owner proof:
`tmp/origin-integration-07a5-Fo5cfh/final-proof.json`, SHA256
`f045c945b48276390336ad7fb5fdbe122b6fbdc66aaa5f9711b8185b5c335480`.
Independent handoff:
`/tmp/cf-origin-integration-review-20261014-fKembD/HANDOFF.md`.
Initial MinIO UID and tmpfs-report-export harness failures are retained.

Actual browser writes through the 07a5 edge and later ccfa edge pass without
adding the native marker: multipart upload/replay, JSON source authorization/
cut/replay, worker READY/checksum/video/Range. Cross-site form returns 403/
no-store; cross-site JSON performs OPTIONS but receives no CORS permission.
Authoritative snapshots of 74 tables, object inventory and upload staging
match before/after negative requests. The parent CDP session could not inspect
the cross-origin iframe response body; that earlier raw harness failure is
retained and the final claim is limited to status/headers/natural provenance
and side effects, not body inspection. Final recorded ccfa proof:
`tmp/web-edge-final-ccfa-gbEOSl/final-ccfa-evidence.json`, SHA256
`b3752843ca8530a4fffe969f830bde88316ad5f133c476b58acd5def983262eb`.

Separate disabled-DevTools actual-app runtime/HMR and new SPA framing now have
independent reproduced acceptance. Populated READY-cut mobile overflow (390→417)
was fixed by two CSS rules at d233; its own native image independently passes
320/390/1440, keyboard and genuine browser positive/negative writes. Owner's
final serialized batch holds the exclusive proof lease across positives and
negative snapshots: `tmp/web-edge-final-d233-zWKEYU/leased-batch-WUb34F/final-leased-handoff.json`.
Independent scope: `/tmp/cf-ui-final-review-20261014-rH35GO/HANDOFF.md`.
Raw old UI FAIL is retained. Separate P2 is now closed: ignored tmp made owner
lint check zero files; actual scan found two test warnings, fixed by test-only
6b9fde9. Independent138-file/0-warning lint and affected6 tests pass; owner full
278 tests/types/build/14 helpers pass. All109 runtime inputs still equal d233.
Changed-file formatting passes under existing CI policy; full-source18 previous
style warnings remain distinct retained FAIL. See `tmp/web-lint-p2-llJLKH/CHECKPOINT-HANDOFF.md`.
The API/
migrate/worker scans remain DENY 145/155/741; source audits deny two high.
No waiver, public/provider deployment, real credentials, application
authentication or production approval is claimed.
