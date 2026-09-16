# Sparse-frame UI implementation checkpoint

Date: 2026-09-16. Status: implemented and independently reviewed; live acceptance
pending. See `SPARSE-FRAME-UI-REVIEW.md`. The REST surface was independently approved before this frontend work;
see `SPARSE-FRAME-API-CONTRACT-REVIEW.md`.

The existing horizontal workspace opens a frame dialog from a READY cut. It
shows bounded history, server-reported job phase/progress, three private JPEGs
with actual cut timestamps and their mapped source positions, and exact version
and checksum details. It adds no player, global store, AI generation or automatic
thumbnail selection. Manual editorial controls remain independent.

The generated OpenAPI DTOs own request/response types. A shared API wrapper
validates untrusted responses and exact project/source/version/cut scope before
Vue Query owns the remote state. Only active work polls. Explicit refresh checks
history, current context/prompt and the selected result; old context does not
hide historical frames when exact source rights still permit reading them.
Admission-off disables creation while the gallery remains readable.

An unresolved request retains its exact scope, body and idempotency key in
validated session storage across reload. A later context change cannot silently
replace that pending request. Confirmed acknowledgement retires only the matching
key; unknown outcomes retain it. Failure to preserve browser identity blocks a
new request. Late responses update only their captured query identity and cannot
switch another cut's visible selection.

Root verification at this checkpoint:

- frontend typecheck and lint passed;
- 24 focused tests passed, including existing pipeline card coverage;
- full frontend suite: 36 files, 211 tests passed;
- production build passed.

New tests cover unknown response plus reload/stale prompt, exact-key retirement,
storage failure, wrong-scope responses, incomplete READY results, historical
stale/readable images, rights-denied images, disabled admission, restored job
states and late responses after target changes. Browser viewport/reload/gallery
acceptance must still run against the restored frame-capable API and worker.

A preliminary real-browser layout check with **mocked frame API responses** passed
at 1440×900 and 1280×720: three images, bounded dialog, accessible close, zero
page JavaScript errors. Evidence is ignored `tmp/frame-ui/visual-evidence.json`
and viewport screenshots. This verifies layout only, not frame runtime behavior.
