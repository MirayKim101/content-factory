# Sparse-frame frontend checkpoint review

Date: 2026-09-16. Independent reviewer: `/root/rollout_review`.
Verdict: **CLEAN for the frozen frontend checkpoint**. Root implemented this
frontend; a different agent inspected its real diff and reproduced verification.
Live browser acceptance against the frame-capable runtime remains outstanding.

Two review findings were fixed before acceptance:

1. The horizontal workspace did not clear its new frame dialog when the project
   left the route or the exact source identity changed. Both lifecycle watches
   now clear that target; regressions cover route and source-version changes.
2. Moving to older history could hide a newer active job and enable another
   creation request. New creation is now disabled on older pages, with a clear
   route back to current history. Replaying an unresolved exact key remains
   allowed. A regression covers active newest history followed by an older page.

The independent final reproduction passed five focused files with **45 tests**
(API wrapper, pending-request storage, frame dialog, job card and horizontal
workspace), frontend typecheck and lint.

The reviewer also checked captured body/key persistence across reload and context
changes, confirmed-rejection-only key retirement, late-response target isolation,
historical viewing with either admission flag disabled, source-rights image
gating, active-visible-job polling, bounded pagination and preservation of the
manual cut/editorial controls. No unresolved frontend finding remains in this
checkpoint. Mocked-browser viewport evidence is recorded separately in
`SPARSE-FRAME-UI-IMPLEMENTATION.md`; it is not live pipeline acceptance.
