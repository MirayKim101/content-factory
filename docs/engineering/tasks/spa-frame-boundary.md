# Private SPA framing boundary

Status: native framing and browser behavior independently accepted in the
diagnostic scope; release security gates remain DENY.

## Scope

Architect browser-boundary review recommended explicit SPA framing protection.
API Helmet headers do not protect HTML served directly by Caddy. The private
console has no approved embedded-console use case; application source inspection
found no iframe-based editor or popup-opener flow. Set the HTML fallback's
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
Keep no-store HTML, immutable hashed assets and the fixed streaming API route.

Official [Caddy header syntax](https://caddyserver.com/docs/caddyfile/directives/header)
and [OWASP clickjacking guidance](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)
were checked before the edit. This deliberately does not add a broad script CSP,
COOP, guessed TLS/HSTS domain, CORS, authentication or JavaScript frame-breaking
code. API Helmet policy, authorization, video/image previews, Range and popup
isolation remain unchanged. It is separate from the API Origin/Fetch Metadata
write policy and does not prevent a cross-site form from sending a request.

## Acceptance and rollback

The preparation unit checks only intended configuration scope, not browser
enforcement. Actual new pinned-Caddy artifact must validate the config and
serve both headers on root and deep-link HTML GET/HEAD, retaining asset/404,
API/health routing and streaming behavior. In a real isolated browser, prove
same-origin and cross-origin iframe embedding of the console is blocked while
top-level navigation, legitimate JSON/multipart writes, video/Range and reload
still work. Keep expected CSP console violations narrowly classified in that
specific negative test; do not suppress application/network errors globally.
Use exact Git context, native provenance/SBOM/fresh all-severity scan and
independent real-diff/reproduced review. Older edge artifacts do not prove the
new header behavior. Backend artifacts retain their actual source revisions
only after exact unchanged input/closure comparison; no relabelling.

Rollback restores a reviewed prior edge configuration only in a private
diagnostic environment; do not present removing the protection as a secure
production workaround. No persistent data, media recipe or provider state
changes. Existing source/artifact denials and deployment gates remain in force.

## Recorded native evidence — 2026-10-14

Both `ccfa179` and final `d233c4f` edge images independently passed six root/deep
GET/HEAD checks, actual same-origin and cross-origin iframe refusal, unchanged
asset/404/API policies, top-level JSON/multipart upload/rights/cut/replay and
decoded video/checksum/206/416. Expected iframe violations are joined to exact
URL/request/loader IDs; five negative classifier controls reject unrelated
failures. Positive writes and unchanged negative 74-table/object/staging
snapshots were serialized under the exclusive proof lease.

Final d233 native index:
`sha256:5f3ac2cf156dc826a23ba9b6c4b5c5d43c3edc65ba0c178bbc07ad59bcea92f6`.
Exact Git/provenance/OCI/SBOM/scan bindings were independently inspected; backend
artifacts retain their unchanged actual 07a5 identities. Scan remains DENY19
(4 HIGH, 8 MEDIUM, 7 UNKNOWN; also 1 LOW), not permission to deploy.
Independent proof/commands: `/tmp/cf-ui-final-review-20261014-rH35GO/HANDOFF.md`;
owner complete d233 evidence:
`tmp/web-edge-final-d233-zWKEYU/final-d233-evidence.json`, SHA256
`cd929cee93cb9a92a0595d3984844887a5f853abae3a8796c1d19b78495304e4`.
The owner passed 256 MiB/65-second transport/failure checks; the reviewer
inspected that evidence, not an independent repeat. The separate false-green
lint P2 is closed by the two-test successor6b9fde9: independently138 files/
0 warnings and affected6 tests pass. Its109 runtime inputs still equal d233;
no rebuild or relabel. Full-source18 historical style warnings remain recorded,
while changed-file formatting passes under existing CI policy. See
`tmp/web-lint-p2-llJLKH/CHECKPOINT-HANDOFF.md`.
