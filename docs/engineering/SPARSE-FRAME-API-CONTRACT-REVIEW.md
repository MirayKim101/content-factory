# Sparse-frame REST contract checkpoint

Date: 2026-09-16. Independent reviewer: `/root/rollout_review`.
Verdict: **CLEAN for the REST/OpenAPI contract; frontend implementation GO**.
This record captures the reviewer's delivered findings and independently
reproduced checks. It does not accept persistence, worker recovery or rollout.

The reviewer inspected the actual controller, DTOs and generated artifacts.
Initial findings about missing request-body metadata, unknown UUID parameter
types, incomplete binary/header/error declarations and unchecked HEAD objects
were fixed before approval. A second pass corrected the legacy-only error-code
enum so the frame error contract truthfully represents its runtime responses.

Verified boundaries:

- required typed POST body, string UUID paths and idempotency header constraints;
- integer list size with default 20 and bounds 1–50;
- bounded dimensions/sample metadata and explicit 202/400/404/409/503 responses;
- private JPEG GET/HEAD with 200/206/416 and range headers;
- exact source authorization before storage access;
- HEAD verifies stored byte count and SHA-256;
- both admission flags are required for new requests, while historical reads
  remain available with admission disabled.

Independent reproduction: `frame-evidence.controller.spec.ts` **10/10 passed**;
`pnpm --dir apps/web check:openapi` **passed**. Generated JSON and TypeScript
matched Nest's exported contract. The interface remains frozen for frontend
work; subsequent contract changes require coordination and regeneration.
