# Sparse-frame integrated worker checkpoint review

Date: 2026-09-16. Independent reviewer: `/root/rollout_review`.
Verdict: **CLEAN for the frozen integrated worker code**. Live runtime recovery
and browser acceptance are separate gates.

The reviewer found and required repair of a crash boundary: `mkdtemp` ran before
claim persistence, so a killed process could leave an unowned scratch directory.
The final application reserves bytes and chooses a unique allowed name before
claim, but creates the directory exclusively after a non-null durable claim.
Pending, rejected or unknown claims create no directory; failures after creation
remain attached to their persisted attempt and execution-stop/recovery record.
The directory format matches the recovery allowlist.

Independent verification on the final fix:

- process application suite: **10/10 passed**;
- worker typecheck and lint: **passed**;
- earlier focused process/storage/policy reproduction: **18/18 passed**.

The implementer's final full worker suite was **114/114 passed**, with build,
formatting and diff checks also passed. These full-suite results are recorded as
implementer evidence, not represented as independently rerun by the reviewer.

Actual-diff review additionally covered currentness before byte access,
PREPARED output ownership before upload, upload settlement before the execution
stop fence, unknown finalization preservation, exclusion from legacy lease
recovery, durable dispatch support, bounded cleanup/reconciliation and shutdown.
No unresolved code finding remains in this checkpoint.

The narrow `.env.example`/Compose addition was separately accepted: the worker
receives only `FRAME_EXTRACTION_CAPACITY=1` and
`FRAME_WORK_DEADLINE_MS=300000`; the new API admission flag defaults off and is
not passed to the worker. Independent Compose validation and scoped diff checks
passed. The separate clean migration and fresh backup evidence are linked from
`SPARSE-FRAME-MIGRATION-PROOF.md` and `SPARSE-FRAME-ROLLOUT-PREP.md`.

## Closing checkpoint: native API startup import fix

The admission-off rollout exposed a native Node24 module-resolution failure:
contracts exported TypeScript source but the two new reexports named missing
`.js` siblings. The implementation owner added package-local `imports` aliases
for the existing `.ts` files and used those aliases in the index. This preserves
the existing source-export boundary and changes no dependency or compiler flag.
Independent reviewer verdict: **CLEAN**. Reproduced native Node24 contracts
import with frame policy assertions, contracts build, compiled API AppModule
import with reflect-metadata and without tsx, and scoped diff-check: all PASS.
This fixes startup; it does not replace the pending live frame acceptance.

Closing staged diff verification: handwritten files pass ordinary
`git diff --cached --check`. Newly staged Prisma-generated models contain
upstream generator trailing spaces; generated files pass with only
`blank-at-eol` disabled. Generated output was not hand-edited to hide this.
