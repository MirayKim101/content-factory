# ADR-003: Exact-version source authorization

- Статус: architect-approved design; implementation pending
- Дата: 2026-09-09
- Автор решения: Content Factory architect (Linux recovery)
- Independent implementation review: pending

This is a new decision reconstructed from the current repository and the latest
product requirements. It is not a recovered copy of a previous ADR.

## Проблема и доказательства

The current upload contract requires multipart `rightsConfirmed="true"` and
immediately writes `Project.rightsConfirmedAt`. Authorization therefore happens
before the server has established the immutable source identity. The actual
source identity only exists after inspection as the tuple
`VideoSource.id + sourceVersion + sha256`.

The required behavior is different: every new upload is `NOT_REVIEWED`; the
owner confirms rights separately for the exact stored version. Until it is
`CLEARED`, the application must deny playback, timestamp selection and cutting,
download, and worker claim. A legacy upload field must never grant clearance.

## Текущие ограничения

- `Project` owns required `rightsConfirmedAt` and
  `rightsDeclarationVersion`; `VideoSource` already owns `sourceVersion` and
  `sha256`.
- The API currently exposes only `POST /api/v1/projects` and
  `GET /api/v1/projects/{id}`. This ADR adds only the confirmation operation
  needed by the requirement; it does not add placeholder media or job routes.
- `SOURCE_READY` continues to mean that media is safely stored. Authorization is
  an independent state and must not be encoded as another upload status.
- The panel is private and has no application user identity. Audit data may
  prove an explicit confirmation and request time, but must not invent an actor.
- PostgreSQL is authoritative. UI checks alone are insufficient.

## Варианты

### A. Сохранить project-level upload checkbox

Cheapest initially, but it cannot bind the declaration to the inspected bytes,
cannot safely handle a replacement version, and lets a caller bypass the gate.
Rejected.

### B. Put authorization fields on `VideoSource`

This is a small migration, but a future in-place `sourceVersion` change could
carry clearance to different bytes. It also loses the prior version's audit
record. Rejected.

### C. Store an immutable authorization record per source version

Add `SourceAuthorization` identified by `(sourceId, sourceVersion)` and also
store `sourceSha256`. Every gate matches all three values. This costs one row
and indexed lookup per version, preserves history, and fits artifact lineage.
Selected.

## Решение и модель данных

Add:

```text
SourceAuthorization
  sourceId             UUID
  sourceVersion        integer
  sourceSha256         char(64)
  status               NOT_REVIEWED | CLEARED
  basis                EXPLICIT_CONFIRMATION | LEGACY_ATTESTATION | null
  confirmedAt          timestamp | null
  declarationVersion   text | null
  createdAt            timestamp
  updatedAt            timestamp
  unique(sourceId, sourceVersion)
  index(sourceId, sourceVersion, sourceSha256, status)
```

`NOT_REVIEWED` requires null confirmation fields. `CLEARED` requires a basis,
timestamp, and declaration version. The application creates the authorization
row in the same transaction as the project, source, and source artifact.
Confirmation locks or conditionally updates the current source and its
authorization row in one transaction. It succeeds only when the submitted
`sourceVersion` and `sourceSha256` still match the stored source.

The existing project-level rights columns become nullable and deprecated. They
remain only as a compatibility record of the old upload attestation; they are
never consulted by access policy. A future source replacement must create a new
`NOT_REVIEWED` authorization row for the new tuple. Old clearance cannot be
copied forward.

One application policy owns the check:

```text
isCleared(sourceId, sourceVersion, sha256)
```

Playback and download check it before returning media, cut creation checks it
before persisting intent, and worker claim repeats it transactionally. Repeating
the check at claim closes the race between queue delivery and source changes.

## REST contract

### Upload compatibility

`POST /api/v1/projects` keeps accepting `rightsConfirmed="true"`, but the field
becomes optional and deprecated. Whether present or absent, every new exact
source version receives `authorization.status = NOT_REVIEWED`. If the legacy
field is present, its factual upload attestation may remain in the deprecated
project fields; it does not clear the source and is excluded from the access
policy and request authorization decision.

The normal owned XHR client omits the `rightsConfirmed` multipart key entirely;
it must not send `false`, a hidden `true`, or append the field after the checkbox
is removed. An omitted field stores null in both deprecated project columns and
returns `rights: null`. Only an old caller that actually sends literal `true`
creates the factual legacy attestation, while its new authorization row still
starts as `NOT_REVIEWED`.

`ProjectResponseDto` adds the required object:

```json
{
  "authorization": {
    "status": "NOT_REVIEWED",
    "sourceVersion": 1,
    "sourceSha256": "<64 lowercase hex>",
    "basis": null,
    "confirmedAt": null,
    "declarationVersion": null
  }
}
```

The deprecated `rights` response remains populated for migrated records and old
callers that actually sent the legacy attestation. It is nullable otherwise.
Only `authorization` is authoritative. Generated clients must be regenerated in
the same delivery.

### Explicit confirmation

```http
PUT /api/v1/projects/{projectId}/source/authorization
Content-Type: application/json

{
  "sourceVersion": 1,
  "sourceSha256": "<64 lowercase hex>",
  "rightsConfirmed": true,
  "declarationVersion": "source-rights-v1"
}
```

The endpoint requires a `READY` source and an exact version/checksum match. Its
transaction applies declaration checks in this order:

1. Reject a missing, non-ready, or mismatched source.
2. If the exact tuple is already `CLEARED` and the submitted declaration equals
   the declaration stored by that confirmation, return immutable `200` without
   comparing it to the server's current declaration version.
3. If that cleared row differs, return `SOURCE_AUTHORIZATION_CONFLICT` and never
   rewrite its audit data.
4. Only for the first `NOT_REVIEWED -> CLEARED` transition, require the server's
   current declaration version; otherwise return `RIGHTS_DECLARATION_OUTDATED`.

This precedence keeps a retry idempotent after declaration rotation without
allowing a new confirmation against outdated text.

Errors use the existing envelope:

- `400 VALIDATION_FAILED`: malformed body or confirmation is not literal true;
- `404 PROJECT_NOT_FOUND`;
- `409 SOURCE_NOT_READY`;
- `409 SOURCE_VERSION_MISMATCH`: version or checksum is stale;
- `409 RIGHTS_DECLARATION_OUTDATED`;
- `409 SOURCE_AUTHORIZATION_CONFLICT`: an already-cleared row differs.

No revoke, playback, cut, download, or worker endpoint is introduced by this
slice. Those features must call the owned policy when implemented. A denial uses
`409 SOURCE_NOT_AUTHORIZED` before job creation; media reads use `403
SOURCE_NOT_AUTHORIZED`. The worker does not claim the job and records a
structured safe reason instead of retrying unauthorized work.

## Миграция и rollout

1. Build and verify the new binary before touching the retained database.
2. Quiesce the only local API for the entire snapshot, migration, and count
   verification window. Stop its terminal with `Ctrl+C`, then verify that
   `ss -ltn '( sport = :3001 )'` shows no listening socket. Do not leave a dev,
   test, or alternate API process accepting uploads.
3. While the API remains stopped, take a fresh database snapshot. An earlier
   root snapshot is useful recovery evidence but does not replace this
   immediately pre-migration snapshot.
4. Run one explicit PostgreSQL transaction (`BEGIN`/`COMMIT`) beginning with
   `LOCK TABLE "Project", "VideoSource" IN SHARE ROW EXCLUSIVE MODE`. In that
   transaction add the enums, table, constraints and indexes, backfill one
   `CLEARED / LEGACY_ATTESTATION` row per existing source, verify
   source/backfill counts and absence of missing or duplicate tuples, and make
   the deprecated project fields nullable. Any failed assertion rolls back the
   whole migration.
5. Still quiesced, repeat the count and constraint verification after commit.
   If it fails, keep the API stopped and restore the fresh snapshot.
6. Start only the new compatible binary, then perform the small upload and
   confirmation smoke. Never restart the old API on the migrated schema.
7. Keep old columns through the compatibility window. Removing them is a later
   contract decision.

No media objects are rewritten. The stop window is required even with database
locks so the old API cannot insert a source after commit and before the new
binary starts.

## Security, operations, and cost

- The gate is fail-closed when the row is missing, mismatched, or unreadable.
- Confirmation logs event, project/source/version, declaration version, request
  ID, and result; it excludes object keys, filesystem paths, and vendor details.
- With no application authentication, the audit proves an action through the
  private panel, not a person's identity. Adding identities requires the future
  authentication decision.
- Runtime cost is one small row per source version and an indexed lookup. The
  code cost is localized to the Projects module and future policy callers.

## Rollback

Before new `NOT_REVIEWED` rows exist, restore the snapshot and the prior binary.
After they exist, do not run the old binary: it assumes non-null project rights
and would misrepresent authorization. Roll back behavior with a compatibility
release that understands nullable legacy fields and keeps the gate fail-closed;
leave the additive table and columns in place. A destructive down migration is
not an acceptable rollback for uploaded media or authorization evidence.

## Критерии успеха

- Every new source tuple is `NOT_REVIEWED`, including uploads that send the
  deprecated field.
- The normal XHR upload omits `rightsConfirmed`; its database rights fields and
  DTO `rights` are null. A legacy literal `true` records only its factual
  attestation and still produces `NOT_REVIEWED`.
- Only an exact-version explicit confirmation changes it to `CLEARED`.
- A changed version or checksum is denied, and a duplicate identical request is
  idempotent.
- After declaration rotation, an identical repeat of an already-cleared stored
  declaration remains immutable `200`; the old declaration is rejected for a
  first confirmation.
- All existing rows migrate to `CLEARED / LEGACY_ATTESTATION` with unchanged
  timestamps and declaration versions.
- Playback, cut, download, and worker claim tests fail closed for a missing or
  non-cleared exact-version record as those operations are introduced.
- OpenAPI drift checks, unit/integration tests, migration test, lint, typecheck,
  and a browser smoke pass; independent review reproduces the evidence.

## Решение tech lead

Option C is architect-approved. Implementation and independent review remain
pending. Any broader source registry, rejection/revocation workflow, evidence
upload, or application authentication is outside this decision.
