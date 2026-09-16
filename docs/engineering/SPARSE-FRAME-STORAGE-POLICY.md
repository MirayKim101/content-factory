# Sparse-frame storage policy preparation — 2026-09-16

The approved Stage 2B-2 contract fixes each private sparse-frame output key to:

```text
ai-content/frame-evidence/{intentId}/attempts/{attemptNumber}/frames/{ordinal}
```

The MinIO API policy therefore adds only this object ARN:

```text
arn:aws:s3:::<bucket>/ai-content/frame-evidence/*/attempts/*/frames/*
```

It grants the existing minimal object action set: Get, Put, Delete, multipart
abort, and multipart-part listing. Existing `sources/*`, `editorial/*`, and
Creator Reference namespaces remain unchanged. A generic `ai-content/*`, an
attempt path outside `frames/*`, unrelated AI paths, and anonymous access are
still denied.

This delivery changes the static provisioning template and regression test only.
It does not apply the policy to MinIO, restart a service, create a database
migration, change feature flags, or introduce a configuration variable. An
independent review must inspect the real diff before the restored runtime is
provisioned for controlled frame extraction.

Independent static review is now **CLEAN**. The reviewer reproduced the focused
policy test, shell syntax and formatting checks. Two test gaps were corrected:
the final regression checks all five statements, the exact bucket statement,
and four exact object action/resource sets, so a new Put/Delete-only or unknown
object-action grant cannot evade validation. Live frame allow/deny checks remain
a rollout gate after scoped provisioning; they are not claimed by this report.
