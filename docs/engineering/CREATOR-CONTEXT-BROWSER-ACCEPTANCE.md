# Creator Context browser acceptance — 2026-09-16

The orchestrator reproduced the Stage 2B-1 desktop workflow in Chromium against
restored Nuxt/API/PostgreSQL/MinIO, with `AI_CONTEXT_ENABLED=1` in API and web.
Result: **PASS**. Independent code/layout review is recorded separately in
[CREATOR-CONTEXT-UI-REVIEW.md](CREATOR-CONTEXT-UI-REVIEW.md).
This is creator/context foundation, not AI generation or full MVP completion.

## Reproduction

Existing pinned Playwright 1.63.0 and its local Chromium were used; no dependency
was installed or upgraded. Local executable evidence:

```sh
export PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/tmp/browser-smoke/browsers"
export LD_LIBRARY_PATH="$PWD/tmp/browser-smoke/sysroot/usr/lib/x86_64-linux-gnu"
node tmp/creator-browser/smoke.cjs
```

The script creates synthetic creator/reference data and edits only the existing
synthetic source/cut context. It uses normal visible browser controls without
forced clicks, records mutation responses, and verifies persisted API state.
The script, JSON response evidence and screenshots are local ignored artifacts;
this report retains the exact identities and assertions. Runtime restoration is
documented in [restored-runtime.md](../infrastructure/restored-runtime.md).

## Exact acceptance fixture

| Entity                 | ID / final state                                     |
| ---------------------- | ---------------------------------------------------- |
| Project                | `282fd2eb-1e82-4fb9-9019-bf3759159802`               |
| Source version         | `6eb9dbc9-4c65-4fa8-a880-fa691615b9b1`, version `1`  |
| READY cut              | `108f6fdd-3016-4cfc-96c5-347d3348d1a7`               |
| Creator                | `7de2e778-d94e-4cda-9dc3-ee46574d3371`, revision `3` |
| Reference              | `6b27ad40-1a9b-4027-ac83-1dc26d18fd30`, READY        |
| Authorization          | revision `3`, REVOKED                                |
| Source context         | `671de184-d600-459a-8c02-516c0d825903`, revision `2` |
| Cut prompt             | `a32fb79f-4414-4cc7-8e0a-6e40d43306f8`, revision `2` |
| Existing manual export | `f504af29-bc47-4a1d-ae74-821be80f939e`               |

Verified sequence:

1. Create creator with official HTTPS URL, notes and restrictions. Private detail
   retains notes; the catalog summary does not disclose them.
2. Upload a synthetic PNG. The asset starts NOT_REVIEWED, and profile default
   stays null. Explicit CLEARED attestation still leaves default null.
3. Explicitly select the reference as default. Profile revision becomes `2` and
   derived likeness availability becomes true. Reload restores private notes.
4. Select that exact creator revision in the cut context dialog; save source
   context revision `1`, explicitly bind and save prompt revision `1`. Reload
   restores the prompt text.
5. Edit the creator, producing revision `3`. Source context becomes STALE and
   the browser displays this state. Explicitly select revision `3` and save
   context revision `2`; explicitly rebind and save prompt revision `2`.
6. Revoke the reference. Derived likeness availability becomes false; REVOKED
   authorization history remains readable.
7. Open the existing manual editorial dialog. Metadata and thumbnail remain
   independently MANUAL. Download the existing ZIP through its browser link;
   its checksum matches the previously accepted package exactly:

   ```text
   14cb7a16d87687f917545e4eb99af6f1d62218590ab080b9d27a0b4c5f25e34a
   ```

All ten mutations returned successful HTTP responses. No browser JavaScript
errors occurred. Existing approval/export did not become stale from creator,
context or reference changes. Full media/manifest verification remains in
[RESTORED-MANUAL-PIPELINE-SMOKE.md](RESTORED-MANUAL-PIPELINE-SMOKE.md).

## Failures found and repaired during acceptance

The first run exposed a missing MinIO creator-reference namespace permission.
A narrow policy repair passed independent positive/negative access probes;
startup reconciliation completed the failed reference cleanup without direct DB
edits. See [storage evidence](RESTORED-CREATOR-REFERENCE-STORAGE-SMOKE.md).

Upload retry classification was corrected across API/UI: an unconfirmed terminal
write returns OUTCOME_UNKNOWN and preserves its identity; only durable terminal
failure permits a new explicit upload attempt. The API regression suite now has
128 tests; the frontend suite has 192. API integration scenarios passed in the
separate disposable acceptance database, never the working runtime database.

A subsequent run exposed an unstyled, oversized context dialog. The application
uses unstyled PrimeVue; this dialog lacked the explicit styling present on other
editors. Dedicated prefixed styles now provide an opaque backdrop/panel, bounded
height, scrollable content and usable selector. The final complete browser run
passed after the layout repair; independent viewport checks are recorded in the
review report.

## Rollback and limits

Admission rollback: set API `AI_CONTEXT_ENABLED=0`, restart the API, and start
web with the same flag disabled. Preserve creator rows, private reference
objects, revisions and manual outputs. No destructive migration is involved.

No AI provider, transcript, frame extraction, generated text/thumbnail, Twitch,
vertical clipping, publishing or analytics was exercised or introduced.
