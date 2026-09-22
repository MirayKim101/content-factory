# Sparse-frame restored-runtime live acceptance

Date: 2026-09-22

The restored local runtime completed the bounded Stage 2B-2 scenario against
the prepared 28-second authorized cut. The run used the direct local API on
port 3001 with `AI_CONTEXT_ENABLED=1` and `EDITORIAL_FRAMES_ENABLED=1`.

The single acceptance harness verified:

- manual editorial ZIP download before and after the frame job, with the exact
  accepted SHA-256 unchanged;
- one POST with a durable idempotency key and a same-key replay returning the
  same intent;
- asynchronous READY completion with exactly three JPEG frames, immutable
  lineage, timestamps, dimensions, checksums and byte ceilings;
- private GET and HEAD responses, immutable SHA ETag and no-store headers;
- a valid byte range (`206`) and an unsatisfiable range (`416`) for each frame;
- no storage keys or credential-like fields in the public response.

Sanitized evidence is retained outside Git at
`tmp/restored-runtime/frames-acceptance/state/evidence.json` with mode `0600`.
The API process and rebuilt restored worker were healthy during the run.

This accepts the local technical frame slice. Worker restart/deadline, Redis
delivery loss, duplicate prevention under recovery and browser reload remain
separate recovery checks before merging the feature branch into `main`.
