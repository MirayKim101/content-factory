# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Diagnostic-only target: prove the effective root context, not just COPY paths.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
COPY . /context
RUN node <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const entries = (directory) => fs.readdirSync(directory).sort();
assert.deepEqual(entries('/context'), ['apps', 'infrastructure', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
assert.deepEqual(entries('/context/apps'), ['worker']);
assert.deepEqual(entries('/context/apps/worker'), ['package.json', 'src', 'tsconfig.build.json', 'tsconfig.json']);
assert.deepEqual(entries('/context/packages'), ['contracts']);
assert.deepEqual(entries('/context/packages/contracts'), ['package.json', 'src', 'tsconfig.json']);
assert.deepEqual(entries('/context/infrastructure'), ['worker']);
assert.deepEqual(entries('/context/infrastructure/worker'), ['entrypoint', 'healthcheck.mjs']);
const manifest = require('/context/packages/contracts/package.json');
const expected = ['index.ts', ...Object.values(manifest.imports).map((target) => path.basename(target))].sort();
assert.deepEqual(entries('/context/packages/contracts/src'), expected);
console.log('EFFECTIVE_WORKER_CONTEXT_CLOSED: exact application/config/contracts; no unrelated apps, tests, credentials, caches or local data');
JS
