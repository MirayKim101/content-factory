# Restored Creator Reference storage smoke — 2026-09-16

## Scope

The live Creator Context browser smoke exposed a local storage-policy gap:
`POST /api/v1/creator-profiles/:profileId/reference-assets` returned
`503 CREATOR_REFERENCE_STORAGE_FAILED` because MinIO allowed only `sources/*`
and `editorial/*`. The API-owned key is
`ai-content/creator-profiles/{profileId}/references/{assetId}/original`.

ADR-008 requires a separate, private namespace for immutable creator reference
images, with checksum, cleanup, and ownership guarantees. The restored runtime
now grants the existing local API service only these object actions for that
exact namespace:

```text
s3:GetObject, s3:PutObject, s3:DeleteObject,
s3:AbortMultipartUpload, s3:ListMultipartUploadParts
arn:aws:s3:::<restored-bucket>/ai-content/creator-profiles/*/references/*
```

No bucket policy, anonymous access, source namespace, editorial namespace,
credentials, database, API code, or frontend code changed.

## Isolated provisioning and live checks

The provisioning change in `infrastructure/minio/provision` was applied only by
recreating `minio-init` in the label-verified
`content-factory-restored` Compose project. It exited `0`; inspection of its
policy showed the exact new resource ARN above. The restored MinIO bucket stays
private.

Using the browser profile `ad366d58-26a6-4988-9758-8873626ceeaf` and existing
synthetic PNG bytes, a new API upload returned `201` and READY asset
`0465cf37-17de-4aec-88cd-4e88a6dcf66e`. Its private API content route returned
`200 image/png`, `Cache-Control: private, no-store`, and the same SHA-256 on
both the API response and downloaded bytes:

```text
dafbd38ed484f44f8ebe37095b110b759cf3f379e0d836730b0e7e8ccec3e30f
```

The negative checks also passed:

- An unauthenticated direct MinIO GET for that exact object returned `403 AccessDenied`.
- The local API storage identity was denied a PUT to the unrelated
  `ai-content/unrelated-denied-probe` key; an administrator check found no
  object at that key.

The original failed upload asset
`bfe4f5cd-843a-45a3-a91d-5cbd469aced8` was left `FAILED_FINAL` and untouched
until the API restarted with `AI_CONTEXT_ENABLED=1`. The ADR-008 startup
reconciler then completed its durable cleanup: its authoritative row is now
`cleanupStatus=COMPLETED`, `cleanupAttemptCount=1`, with completion timestamp
`2026-09-16T03:01:26.959Z`. No direct database deletion or update was used.

Independent review must repeat the exact allow/deny checks and confirm the
startup reconciliation before this runtime repair is accepted.
