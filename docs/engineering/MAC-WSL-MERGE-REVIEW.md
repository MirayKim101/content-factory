# Mac–WSL merge review

Date: 2026-09-09

Reviewer: independent implementation reviewer

Verdict: **CLEAN within the reviewed scope**

## Scope

This was a read-only review of the merge delta against
`import/mac-transfer-20260909`. It covered four worker recovery ports and the
small merge adaptations made to the creator UI, OpenAPI export, generated-client
CI, and Docker build-context exclusions.

The review did not run the application, containers, migrations, media jobs, or
the full test suite. Those checks were waived for this merge by the owner and
remain separate from this verdict. The recovered Stage 2B creator UI is
preserved work in progress; this review does not accept its product behavior or
user workflow.

## Worker recovery ports

1. **Ambiguous cut finalization.** A lost database response after commit now
   triggers an exact reread of the `READY` cut job and its accepted
   `CUT_RESULT`. The worker does not delete the uploaded object when acceptance
   cannot be determined. The reread binds job, project, source lineage, role,
   status, and object key.
2. **Already-aborted multipart upload.** The S3 adapter registers the abort
   listener and immediately propagates an already-aborted caller signal before
   starting multipart work.
3. **Crash-safe media scratch cleanup.** Ordinary media scratch identity is
   encoded atomically in the directory name. Startup and periodic reconciliation
   use a grace interval, query candidates in bounded batches, and delete only
   directories whose exact job attempt is terminal in PostgreSQL. A missing or
   invalid metadata marker falls back to directory modification time without
   weakening the database gate.
4. **Worker lifecycle and readiness.** Queue consumption starts with
   `autorun: false` after startup reconciliation. Readiness is published only
   after the consumer is ready and running. Unexpected consumer completion or
   rejection removes readiness and produces a nonzero exit. Graceful shutdown
   removes readiness first, waits for active BullMQ work to stop, and only then
   closes cache, PostgreSQL, and storage resources. The healthcheck requires the
   readiness marker in addition to dependency probes.

The review also confirmed that the imported worker still verifies source size
and SHA-256 before media processing, treats invalid source probe results as
final while abort/timeouts remain retryable, persists output intent before
upload, requires the exact live lease for heartbeat/finalization, and excludes
the accepted artifact from cleanup.

## Merge adaptations

- OpenAPI generation imports the Nest application only after installing inert
  contract-generation environment values, allowing clean-checkout export while
  preserving application cleanup and deterministic serialization.
- The creator-context revision field uses a native numeric input, and creator
  profile saves use separate create and update branches so
  `expectedRevision` is sent only for updates.
- The generated-client CI workflow uses pinned actions and Node, a frozen
  install, Prisma generation drift checks including untracked output, and builds
  the dependent packages.
- The worker Docker build context is a closed allowlist containing only its
  declared workspace inputs and infrastructure scripts. Credential, cache,
  temporary, repository-metadata, and strictly prohibited directory patterns
  remain excluded after allow rules.

## Evidence and limitation

The reviewer inspected the real file and SQL diff, followed control flow for
success, lost-response, abort, restart, and shutdown paths, and ran
`git diff --check` over the reviewed worker and healthcheck paths successfully.
No reviewer runtime or test evidence is claimed. The implementer separately
reported successful worker typecheck, build, healthcheck syntax, and diff checks;
the orchestrator owns final build and contract evidence.
