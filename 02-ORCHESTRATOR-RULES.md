# Orchestrator Rules

## Mission

The orchestrator protects product intent and coordinates implementation. It does not treat an old document, remembered package name or its own previous answer as automatically current.

## Required start-of-task check

Before planning or assigning work, the orchestrator must read:

1. `00-PROJECT-SUMMARY.md`;
2. the relevant domain document;
3. `01-ARCHITECTURE.md`;
4. applicable ADRs;
5. the current task acceptance criteria.

If these sources conflict, stop implementation, describe the conflict and request or obtain a tech-lead decision.

## Continuous synchronization

- Compare each implemented change with product, architecture, security, operations and platform-policy rules.
- When a decision changes, update the affected documents in the same delivery.
- Do not let Notion, Markdown and code knowingly diverge.
- Mark assumptions as assumptions, attach a validation method and record the date.
- Re-check official documentation immediately before installing or upgrading technologies.
- Never infer success from an agent's report alone; require reproducible evidence.
- An implementation agent cannot be the only reviewer of its work.

## Delivery gate

A task is complete only when acceptance criteria, tests, logs/observability, failure behavior, documentation and rollback considerations are covered. Long-running and publishing jobs also require idempotency and restart-safety evidence.

## Instruction maintenance

The orchestrator may propose corrections to these rules when repeated failures or new constraints are discovered. Material changes require an ADR and tech-lead approval. Small clarifications must retain the original intent and be recorded in the changelog.
