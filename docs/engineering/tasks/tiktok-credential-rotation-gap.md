# TikTok credential rotation — pre-canary discovery

Status: finding reproduced with a mock; bounded remediation specification approved.
No production adapter is selected and no provider was called.

## Evidence — 2026-10-14

While checking that safe HTTP methods cannot initiate writes, inspection found:

- `publishing/presentation/publication.controller.ts` exposes creator-info as
  GET. Its application service performs a provider OAuth refresh before the
  creator query on a cache miss.
- `publishing/application/get-tiktok-creator-info.ts` consumes the returned
  access token but does not preserve a returned replacement refresh token.
  Its thirty-second cache/pending map is process-local, not cross-replica or
  restart-safe credential coordination.
- Worker `infrastructure/tiktok-oauth-access-token-resolver.ts` also refreshes
  from injected credentials and caches only the access token. It does not
  update the injected refresh credential or persist a replacement. Separate
  API and worker caches do not coordinate one remote credential owner.

These are source observations, not a demonstrated credentialed failure. The
official [TikTok user-token documentation](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
was checked: a refreshed response may contain a different refresh token, which
must replace the prior one. Losing that replacement can therefore prevent
later API/worker access or recovery. No claim is made that every refresh
rotates or immediately invalidates the previous token.

Existing unit fixtures verify identity, scopes and bounded responses but do
not exercise rotating refresh-token persistence across API/worker/restarts.
Current provider admission remains disabled; local mock success is not a
credentialed canary. A browser-write guard on unsafe methods alone does not
prevent the existing GET from initiating this remote credential operation.

## Bounded mock reproduction

The actual committed API query and worker resolver from frozen `07a5` were
executed against an injected, entirely synthetic provider. Its first OAuth
response explicitly returns a replacement fake refresh token; later use of
the prior fake token returns invalid_grant. No global fetch, live provider,
deployment credential, environment flag, database or native service was used.
Both imported source files were byte-compared with exact Git blobs first.

Observed: the API's initial query succeeds but its next refresh reuses the
stale injected value and fails. Worker initial resolution succeeds; both
access-token expiry and a reconstructed resolver after simulated restart
reuse the stale value and fail. This reproduces the **gap under a rotating
provider mock**, not a real credentialed outcome or a claim that all provider
refreshes rotate. An initial CJS-loader setup error and an incorrect error-name
assertion are retained as harness failures, not product findings.

Private script: `tmp/tiktok-rotation-proof-1t7KNu/rotation-proof.mts`, SHA256
`1b452a8b7e41f348cb13ed5b7c9cdd53b0e0108a8fdb5370381997affbbbda73`.
Proof: `tmp/tiktok-rotation-proof-1t7KNu/proof.json`, SHA256
`78eab2db181111a38238d845b491f2569c43ad089d506ba0b37ffcee1dfb60b2`.
The two source hashes, synthetic request counters and non-approval boundaries
are recorded there. No remediation is implemented by this reproduction.

## Authority boundary

ADR-010 and `stage3d-external-publishing.md` require deployment secret/config
references and prohibit saving provider credentials in PostgreSQL, job payload,
API responses or logs. Do not silently introduce an encrypted credential table
as a fix: that would conflict with the current approved boundary. Existing
encrypted resumable publication sessions are not an OAuth credential store.

The architect approved the bounded contract below as ordinary completion;
implementation follows the current browser/runtime checkpoint. It does not
approve any PostgreSQL credential table or actual secret-service deployment.
Actual secret-manager/provider configuration still requires deployment facts;
no account, paid service, credentials or real refresh is authorized here.

## Required remediation acceptance

Bounded mock acceptance must cover rotation and replacement durability, shared
API/worker identity, concurrent refresh ownership, version/CAS or equivalent
fencing, restart and lease loss. An ambiguous remote refresh must not silently
repeat an invalid old credential or leak a returned replacement; specify the
controlled operator re-authorization outcome when recovery is impossible.
Cancellation, redirect refusal, timeout, identity/scope validation and secret
redaction remain mandatory. Avoid treating an OAuth refresh as an idempotent
publication retry.

Separate a side-effect-free cached creator-info read from an explicitly
guarded refresh operation, or approve an equivalent no-GET-mutation contract.
Update OpenAPI/client/UI together and prove cross-site reads/forms cannot
trigger refresh. Run relevant large batches and independent review before any
bounded real provider/channel canary. This discovery does not claim a fix or
invalidate the narrower previous local dry-run evidence.

## Architect-approved next slice — 2026-10-14

No new material ADR is needed for a default-denied TikTok boundary and an owned
secret-rotation port with fake-adapter proofs. An actual adapter/service choice
and its operating guarantees remain unresolved. Other providers, local dry-run
and manual ZIP export must not be globally disabled to fence TikTok.

Effective TikTok admission requires requested flags **and** a configured,
verified rotation-capable credential owner. Static refresh-token JSON alone
is not sufficient. Missing capability returns a safe reason such as
`TIKTOK_CREDENTIAL_ROTATION_UNAVAILABLE` before new runnable persistence or
provider I/O. Queued TikTok claims must not consume attempts or perform refresh/
publication. Keep intents, encrypted resumable sessions, remote IDs and unknown
outcomes intact; preserve a reconciliation/recovery path for possibly committed
publications, not a new blind upload or a fabricated terminal state.

The provider-neutral deployment-secret port represents one logical owner per
actual OAuth grant: provider/application identity plus immutable external user,
not merely an internal channel UUID. Two bindings sharing a grant share refresh
ownership. Required protocol:

- read the latest versioned secret bundle;
- exclusive cross-process refresh admission and fencing;
- durable operation identity/state before dispatching a refresh;
- conditional replacement of validated access/refresh tokens, expiry, identity
  and scopes, followed by durable acknowledgement;
- read-back recovery after an uncertain store commit;
- durable quarantine/reauthorization state.

Never release the returned access token for downstream work until its credential
update is durably acknowledged. Handle an unchanged replacement token too.
CAS after a remote call is insufficient to prevent duplicate remote refreshes.
An expired lease whose request might have been dispatched becomes uncertain;
it does not authorize refreshing again with the old token.

Proven non-dispatch can permit bounded retry. A committed replacement can be
recovered by version/operation read-back. A possibly processed refresh with an
unavailable replacement must quarantine the grant and return controlled
`TIKTOK_REAUTHORIZATION_REQUIRED`. Cross-system atomicity cannot be promised;
exceptional loss can require operator reauthorization. No secret data belongs
in PostgreSQL, jobs, public errors/responses, evidence or logs.

Creator-info GET becomes cache/read-only with zero OAuth **and** creator-query
network calls on miss or expiry. Return freshness metadata or a documented
refresh-required/unavailable result; cache keys include exact binding and
credential generation. A guarded POST schedules/reuses bounded owner work;
repeated requests coalesce through durable operation identity. Future background
refresh uses the same owner, never a browser GET or blanket callback exemption.

Fake proofs require T0→T1→T2 across reconstruction/expiry, one owner under
concurrent API/worker calls, lease loss/delayed response/crash/ambiguous commit,
no stale overwrite/reuse, no provider calls or secret writes on denied GET/
cross-site/static-only/missing-adapter admission, redaction and unchanged other
providers/manual export. Relevant API/worker/contracts/UI large batches and
independent reproduced review are mandatory. A persistent fake proves only the
protocol, not production durability. Selecting real storage needs explicit
atomicity, ownership, permissions, encryption, backup/recovery, availability,
cost and incident decisions; new topology or PostgreSQL secrets need material
ADR review. Real TikTok canary remains blocked independently of this local work.
