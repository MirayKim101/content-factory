# Content Factory — instructions for Codex

## Product authority

Before planning or changing code, read:

1. `00-PROJECT-SUMMARY.md`;
2. the relevant domain document;
3. `01-ARCHITECTURE.md` and `ARCHITECTURE.md`;
4. applicable ADRs under `docs/decisions/`;
5. the current task acceptance criteria.

If these sources conflict, stop implementation and surface the conflict for an
architect decision. Do not silently choose one source.

## Human communication

The owner is learning the workflow. Explain work in small numbered steps:

1. what is being done now;
2. why it is needed;
3. the exact command or UI action when the owner must act;
4. the expected visible result;
5. how success is verified.

Avoid unexplained jargon. Never require the owner to infer the next action.

## Protected external directories

Never read, write, rename, move, delete, execute from, or otherwise interact
with directories named `seanova` or `dockerServer`. They are outside this
project's scope even when the current permission mode allows access. A new,
explicit owner instruction is required to change this rule.

## Team operating model

The primary Codex thread is the manager/orchestrator. Project-scoped custom
agents live under `.codex/agents/`.

- Use one implementation owner for one vertical slice.
- Delegate only bounded work with explicit acceptance criteria.
- Prefer parallel agents for independent read-only research or verification.
- Do not let multiple agents edit shared contracts, schemas, lockfiles, or the
  same feature concurrently.
- Frontend and backend agents may work in parallel only after the API contract
  is approved and their file ownership does not overlap.
- DevOps is invoked only for infrastructure, deployment, CI/CD, or
  observability work.
- Architect approval is required for a material baseline change or ADR, not
  for ordinary implementation inside the approved architecture.
- The agent that implements a change cannot be its only reviewer.
- The reviewer must inspect the real diff and reproduce verification; an
  implementation report is not evidence.

Default delivery sequence:

```text
owner request
-> orchestrator specification and acceptance criteria
-> architect check when needed
-> one bounded implementer
-> QA verification when the task needs a separate test-design pass
-> independent reviewer
-> orchestrator synthesis for the owner
```

## Current MVP boundary

Follow `docs/product/MVP-ROADMAP.md`.

- Stage 1 proves local manual upload, manual timestamps, background FFmpeg
  cutting, status, controlled failure, and result download.
- Stage 2 adds the full local horizontal editorial pipeline and reusable
  self-promotion or advertising overlays.
- Stage 3 adds Twitch ingestion, provider-neutral AI vertical clipping,
  publishing, and analytics.
- Do not introduce automatic highlight detection or an external clipping
  provider before Stage 3.
- AI development agents and AI product features are separate concepts.

## Architecture and engineering rules

- Deliver vertical slices across the necessary UI, API, persistence, worker,
  tests, and documentation surfaces.
- Keep the Nuxt frontend and NestJS backend independent behind a versioned REST
  API and generated OpenAPI client.
- PostgreSQL is authoritative state. Redis/BullMQ is disposable coordination.
- Long-running media or publication work never runs inside an HTTP request.
- External systems stay behind owned ports.
- Workers and publishing operations must be idempotent and restart-safe.
- Preserve artifact lineage, checksums, recipe versions, and structured logs.
- Do not introduce microservices, Kubernetes, event sourcing, GraphQL,
  multi-tenancy, billing, or public registration without an approved ADR.
- Check current official documentation before installing or upgrading a
  dependency. Pin reproducible versions and commit the lockfile.
- Update affected documentation in the same delivery as behavior changes.

## Required verification

A delivery is complete only when relevant checks pass:

- formatting and lint;
- TypeScript typecheck;
- unit and integration tests;
- API contract checks when the contract changes;
- a smoke test of the user-visible scenario;
- controlled failure behavior;
- logs or other reproducible evidence;
- documentation and rollback considerations.

Long-running jobs additionally require retry, idempotency, restart-safety, and
duplicate-prevention evidence.

## Code review rules

Prioritize correctness, data loss, security, authorization, job recovery,
duplicate publication, incompatible API changes, missing tests, and divergence
from the documented product boundary. Report findings with tight file and line
references plus reproduction evidence. Avoid style-only comments unless the
style issue hides a behavioral risk.
