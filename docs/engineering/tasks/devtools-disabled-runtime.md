# Application runtime with optional DevTools disabled

Status: actual disabled application runtime independently accepted; separate
source lint P2 closed on the test-only successor, security DENYs unchanged.

## Decision — 2026-10-14

Explicitly disable Nuxt DevTools through its supported `devtools.enabled=false`
configuration. The architect classifies this as ordinary bounded mitigation,
not a material ADR or framework-baseline change. Keep the reviewed compatible
3.4.3 lock; Nuxt/Vue/PrimeVue and the private SPA/REST boundaries are unchanged.
Official [3.4.3 module source](https://raw.githubusercontent.com/nuxt/devtools/v3.4.3/packages/devtools/src/module.ts)
returns before loading its main module when disabled.

Preserve c44's strict startup FAIL: missing-token HTTP verification caused two
vendor write-after-end uncaught exceptions even though the process exited zero
and bounded RPC/Git/token assertions passed. The new acceptance can establish
only **application usability with DevTools disabled**, not a vendor repair.
No actual 3.4.2 runtime reproduction is claimed. No dependency/vendor patch,
advisory exception or package-action permission is introduced.

## Successor acceptance

1. Freeze an exact Git successor and verify the configuration delta. Compare
   all backend source/contract/closure inputs to 07a5, retaining those native
   artifacts' actual labels; never rewrite provenance. A new edge needs its
   own exact-source build, max provenance, SBOM and fresh all-severity scan.
2. Start the **actual application** in development mode without TEST/VITEST
   shortcuts. Use only a closed frozen source and verified dependencies, fresh
   isolated configuration/cache/token roots, no package-manager actions or
   published host ports. Never read the operator's real profile/token.
3. Verify effective DevTools disablement and absence of registered DevTools
   HTTP/WebSocket/RPC handlers, token-store creation and package-action calls.
   A generic SPA fallback returning 200 proves neither endpoint presence nor
   absence. Inspect actual registration/effective configuration, not just status.
4. Require clean startup/request/HMR/shutdown logs: no uncaught exception,
   unhandled rejection or write-after-end, irrespective of process exit zero.
5. Repeat full web unit/lint/type/static-generation gates; exercise browser
   navigation/reload/HMR and legitimate JSON/multipart API writes. Preserve
   07a5 browser proofs at their original revision; do not relabel them.
6. Independent reviewer inspects the real diff and reproduces the disabled
   runtime proof. Source and all artifact denials remain in force.

## Recorded runtime evidence — 2026-10-14

The actual application at `80c4cdb` independently passed development startup,
reload, two browser-observed HMR transitions and clean shutdown. Registration
inspection found no DevTools HTTP/WS/RPC/hooks, token store or package actions;
all 163 source inputs were restored. Natural browser upload/rights/cut/replay,
worker READY and checksum/206/416 passed. Final `d233c4f` retains the same runtime
configuration, script/template and dependencies; its two CSS rules separately
passed native 320/390/1440 checks. Owner repeated disabled-dev/HMR and browser
mutations under the exclusive proof lease, followed by matching negative
74-table/object/staging snapshots. Owner evidence:
`tmp/web-edge-final-d233-zWKEYU/leased-batch-WUb34F/final-leased-handoff.json`,
SHA256 `1fb25c1bde5917b1a0ab8f4030916fd88b185a3df379bc96a72bb9a34a1855ee`.
Independent scope, commands and hashes:
`/tmp/cf-ui-final-review-20261014-rH35GO/HANDOFF.md`.

The reviewer also found that owner lint in an ignored `tmp/` fixture checked
no files. Real independent lint scanned 138 files and failed two existing test
warnings. Successor `6b9fde9` changes only those two tests; independent lint138/
0 warnings and affected6 tests pass. Owner full278/types/static build/14 helpers
pass; changed-file formatting passes under the existing CI policy. The same18
pre-existing full-source style warnings remain separately recorded FAIL, not
silently reformatted or waived. All109 runtime inputs match d233. Evidence:
`tmp/web-lint-p2-llJLKH/CHECKPOINT-HANDOFF.md` and reviewer `p2/HANDOFF.md`.
Preserve the false-green history and actual lint failure; P2 is now closed.

## Rollback policy

Do not silently re-enable the broken optional surface to restore a dev panel.
Re-enablement requires an upstream fix plus the previously failing runtime and
authorization checks, with independent review. Product UI, uploads and workers
must remain available without that panel. No schema, persistent data, provider,
credentials, public gateway or TLS configuration is changed. This mitigation
does not close unresolved source advisories, artifact findings, manual montage
rights, deployment/storage decisions or real provider acceptance gates.
