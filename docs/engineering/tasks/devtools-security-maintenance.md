# Compatible Nuxt DevTools security maintenance

## Scope and acceptance

Architect-approved ordinary maintenance, 2026-10-14. The exact source baseline
is `464aeb9c54b7c4b1341d9b7533cedbd715f87c96`. This owner changes only
`pnpm-lock.yaml` and this taskdoc; private proof scripts are under
`tmp/devtools-maintenance-3UMlQV`. No shared-index staging, branch commit, push,
Dockerfile, manifest, override, lifecycle-policy, schema, contract or application
behavior change belongs to this slice. Main's browser-origin guard is separate
and is not present in this baseline fixture.

Acceptance requires the exact bounded dependency delta, compatibility of every
affected parent edge, preservation of all sixteen previous security-resolution
edges, a strict cold frozen install, the complete 324-test API gate and both
fresh source audits without exceptions. Confucius separately owns the full web
278-test/build/type/browser gate and read-only DevTools startup/token/Git proof
against the frozen successor candidate. Those checks are not claimed here.

## Official-source verification and actual delta

The [official 3.4.3 release](https://github.com/nuxt/devtools/releases/tag/v3.4.3)
and [pnpm 10 update documentation](https://pnpm.io/10.x/cli/update) were checked
before installation. Exact official npm registry manifests/SRIs for Nuxt 4.5.2,
all three old/new DevTools packages, package-manager-detector 1.8.0 and tinyexec
1.3.0 are retained in `registry-proof.json`. Nuxt's existing DevTools range is
`^3.4.1`; no broader Nuxt/Vue/compiler upgrade is needed.

The final lock changes are exactly:

- `@nuxt/devtools`, `@nuxt/devtools-kit`, `@nuxt/devtools-wizard`:
  `3.4.2 -> 3.4.3`, with their official new SRIs;
- add `package-manager-detector@1.8.0` through DevTools' `^1.8.0` range;
- reuse existing `tinyexec@1.3.0` through DevTools' `^1.3.0` range;
- remove unreachable `simple-git@3.36.0`, `@simple-git/argv-parser@1.1.1`,
  `@simple-git/args-pathspec@1.0.3`, `@kwsites/file-exists@1.1.1` and
  `@kwsites/promise-deferred@1.1.1`;
- remove DevTools' direct nypm edge and its now-unneeded `supports-color`
  transitive-peer marker. `nypm@0.6.9` remains needed by other existing parents.

The original pinned-pnpm compatible named-package update ran only in a closed
source fixture:

```sh
pnpm --recursive update @nuxt/devtools @nuxt/devtools-kit @nuxt/devtools-wizard --depth 100 --lockfile-only
```

It generated out-of-scope descendant choices: clack/core 1.5.1, clack/prompts
1.8.1, tinyexec 1.3.1 and detector 1.9.0. This was reported to Main before any
shared lock write. The complete rejected output remains
`unaccepted-resolver-lock.yaml`; it was never applied to the shared lock.
The bounded mechanical regeneration retained compatible existing clack and
tinyexec resolutions, used the three pnpm-generated DevTools records, and used
the detector 1.8.0 package/snapshot records generated separately by the same
pinned pnpm from an isolated exact-version manifest. No Content Factory
manifest or override was added or changed.

`accept-lock.mjs` compares the entire parsed lock against the explicitly bounded
baseline transformation, not only selected lines. It checks 45 outgoing and
three incoming affected constraints, all removed packages' old incoming edges
and their absence in the successor, all seven unchanged manifest/workspace
boundaries, and all sixteen preserved prior-resolution edges. Nuxt/Vue/compiler
and every other package/snapshot remain unchanged except the stated edges.
The final lock diff is 19 insertions / 54 deletions; SHA-256:
`1890516b8033e25f655c61a7b4d71f6f5197536c511b6c5974a3486b8fc6c273`.

## Closed source, cold install and API verification

Fixture: `/tmp/cf-devtools-source-zTaNhJ`, materialized from 525 allowlisted
regular Git blobs of the exact baseline. All protected pending API originals,
`.idea`, root `package-lock.json`, environment files, local data and protected
external directories are excluded. The three required API paths are present
only as their committed ADR-011 blobs; no working versions are read or copied.
Only the reviewed successor lock is substituted into the fixture.

Node 24.15.0 and pnpm 10.34.5 performed a complete frozen install from a verified
empty `/tmp/cf-devtools-cold-store-Zmn3bH`: 930 downloaded, zero reused, exit 0.
`strictDepBuilds` stayed true, with the existing exact `allowBuilds` policy.
Only the previously approved esbuild, Prisma engine/CLI and vue-demi lifecycle
steps ran. No DevTools package-action install/update/remove RPC, wizard or
vendor command that disables strict builds was invoked. The known vendor
package-action strict-build bypass is not repaired or approved by this lock
update; read-only startup proof must not trigger those actions.

The full API batch passed after the completed resolution change: 65 files,
324 tests, formatting of the existing forwarding regression, zero-warning
lint, strict types, production build, deterministic OpenAPI JSON and generated
TypeScript client. No new application test was needed for this dependency-only
slice; the existing real HTTP forwarding and upload-staging failure proofs ran
again. `gate-results.json` records every command, explicit inert environment,
timestamp, exit code and log hash. `unit-results.json` is in the source fixture.

The post-gate source check compares all original inputs against their committed
hashes. Pinned Prisma generation may reproduce the existing single tracked
generated model with trailing horizontal whitespace only; the proof records
both hashes and asserts normalized equality rather than hiding the difference.
That derived output is not copied to the shared working tree or frozen as a
source edit.

Reproduction from the closed fixture (choose another empty store for a new
cold-install claim):

```sh
cd /tmp/cf-devtools-source-zTaNhJ
export PATH=/home/miray/Projects/ContentFactory/tmp/runtime-node24:/tmp/cf-devtools-source-zTaNhJ/node_modules/.bin:$PATH
export S3_ACCESS_KEY=cf_unit_fixture_only S3_SECRET_KEY=cf_unit_fixture_only
export REDIS_PASSWORD=cf_unit_fixture_only
export POSTGRES_USER=cf_unit_fixture_only POSTGRES_PASSWORD=cf_unit_fixture_only POSTGRES_DB=cf_unit_fixture_only
export API_UPLOAD_STAGING_SAFETY_BYTES=0 CI=true
unset DATABASE_URL S3_ENDPOINT REDIS_URL
pnpm install --frozen-lockfile --store-dir /tmp/cf-devtools-cold-store-Zmn3bH --config.strict-dep-builds=true
pnpm --filter @content-factory/api db:generate
pnpm --filter @content-factory/api exec oxlint --deny-warnings src test scripts
pnpm --filter @content-factory/api typecheck
pnpm --filter @content-factory/api build
(cd apps/api && pnpm exec vitest run --reporter=default --reporter=json --outputFile=../../unit-results.json)
pnpm --filter @content-factory/api check:openapi
pnpm --filter @content-factory/web check:openapi
pnpm audit --json --audit-level moderate
pnpm audit --prod --json --audit-level moderate
```

The actual runner additionally removes inherited npm/pnpm configuration env
variables before invoking the pinned absolute pnpm executable. It never copies
an environment file or uses live provider/database credentials.

## Audit result, handoff and rollback

Both fresh source audits return exit 1 / DENY: two high advisories, zero critical,
moderate or low. Only `node-forge` (`GHSA-86w9-cpqp-85rv`) and `braces`
(`GHSA-vfj7-8cjw-p6xm`) remain, both without a compatible published fix in the
actual audit. The four prior simple-git/argv-parser advisories are gone through
removal of their unreachable dependency closure, not a major override.
Complete JSON/path reports remain `audit-full.log` and `audit-prod.log` in the
private evidence directory. No advisory suppression, threshold change or
allowlist was used. Source DENY continues to prohibit promotion/deployment.

`final-proof.json` binds the exact temporary-index Git tree and its only two
owned changed blobs, the unchanged shared-index checksum, source and lock
hashes, installed versions/removal inventory, cold-install log, complete API
evidence and both full audit reports. It is a tree object, not a branch commit;
Main creates the eventual reviewed combined candidate. Independent review,
the separately owned web proof and browser-origin guard remain required. No
new native image, runtime scan, production rollout or external access is
claimed by this dependency slice.

Rollback is a reviewed coordinated revert of this lock/taskdoc pair followed
by a fresh frozen install and repeated API/web gates. There are no schema,
persistent-data or credentials changes to reverse. Reverting restores the
known vulnerable DevTools dependency graph and is not a security-clean state.

## Separate frozen c44 web and isolated DevTools verification

Web owner verification uses commit `c44f0fc7401cb9231591cc1a052516204a4f9586`,
tree `6f7d77ff87a2230c040708456528fb37eefe5f10`, not the mutable checkout.
Private evidence is `tmp/devtools-web-c44-CJeNlU`; the source manifest records
160 exact Git files and seventeen hash-checked dependency-closure inputs reused
from the completed cold fixture. No package-manager action was performed by
this verifier. Full web verification passes: 51 files / 278 tests, zero-warning
lint, strict typecheck and static `nuxt generate`; thirteen edge helper tests
also pass. Commands and exit codes are in `gates-prepared/web-gates.json`;
`13-helpers.log` and `helper-source-proof.json` retain helper evidence.

Actual startup used an isolated, non-root, read-only private Node diagnostic
container, no network or published ports, fresh tmpfs configuration/token and
read-only dependency mounts. All three installed DevTools packages are 3.4.3.
The synthetic Nuxt fixture listened only on container-loopback port 3117.
Composed RPC functions `getServerConfig`, `getStorageMounts`, `getStorageKeys`
reject missing, empty and wrong tokens (nine checks); valid-token read calls
return the synthetic configuration and memory storage only. Actual Git read
RPC returns `fixture-readonly#724eeaa-dirty` using a synthetic private repository
and a fence allowing only three read commands. This is composed-function proof,
not a WebSocket transport authorization claim. No package-action RPC or host
profile/token was used, and no token value was recorded.

**Overall DevTools startup acceptance FAILS.** HTTP auth verification returns
403 for a wrong token, 200 for a valid token and 400 for a missing token, but the
last request causes two vendor `uncaughtException: write after end` errors at
`@nuxt/devtools/dist/chunks/module-main.mjs:11888` and `:11895`. The vendor
missing-token branches end the response without returning. The process logs
these errors while exiting zero, so neither exit zero nor the raw probe's
fourteen bounded response assertions is sufficient for acceptance.
`startup-attempt4/devtools-auth-proof.json` retains that raw PASS unchanged;
`strict-startup-validation.json` binds its hash and stderr hash and records
the overriding FAIL. Earlier attempts 1–3 are preserved as harness failures
(package-export inspection, then incorrect native Git basename), not erased
or represented as product regressions. The corrected fourth attempt supplies
the actual vendor finding. No dependency/vendor patch or exception is applied.

Reproduce the private startup with
`tmp/runtime-node24/node tmp/devtools-343-prep/run-auth.mjs 5`, choosing an
unused attempt number, then inspect both response proof and stderr. The
synthetic token exists only in that container's tmpfs. Private runners and
attempt logs remain available for independent review. The static web result
does not cure this development-runtime defect, either unresolved source audit,
or the separate all-severity artifact gate. No c44 native edge build, deployment,
security approval, branch commit or push is claimed here. Combined 07a5 edge
and genuine-browser origin checks are separate evidence, not relabelled c44
results.
