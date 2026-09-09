# Linux readiness

Verified: 2026-09-09

This repository requires Node.js `>=24.15.0` and pins pnpm `10.34.5` in its
root `package.json`. The checked-in `pnpm-lock.yaml` is the only dependency
resolution source.

The verified host is Linux on WSL2 (`6.18.33.2-microsoft-standard-WSL2`,
`x86_64`). Docker Desktop 4.89.0 provides Docker Engine 29.7.2 through the
default context.

## Local runtime used for this checkout

The WSL host originally provided Node.js `v22.22.1`, which does not satisfy the
repository engine constraint. A project-local, ignored runtime was installed at
`tmp/runtime/node-v24.15.0-linux-x64`:

| Tool                                             | Verified version |
| ------------------------------------------------ | ---------------- |
| Node.js                                          | `v24.15.0`       |
| npm bundled with Node.js                         | `11.12.1`        |
| Corepack                                         | `0.34.6`         |
| pnpm, resolved by Corepack from `packageManager` | `10.34.5`        |

The `node-v24.15.0-linux-x64.tar.xz` archive was downloaded from the official
[Node.js v24.15.0 archive](https://nodejs.org/en/download/archive/v24.15.0),
then validated against its official `SHASUMS256.txt`. Its SHA-256 is
`472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6`.

pnpm's [official installation documentation](https://pnpm.io/installation)
confirms that pnpm 10 supports Node.js 24 and that a project can pin pnpm with
the `packageManager` field. Corepack therefore owns the exact pnpm version in
the ignored `tmp/runtime/corepack` directory.

## Use the local runtime in a new shell

From the repository root, run:

```sh
export CF_RUNTIME="$PWD/tmp/runtime"
export PATH="$CF_RUNTIME/bin:$CF_RUNTIME/node-v24.15.0-linux-x64/bin:$PATH"
export COREPACK_HOME="$CF_RUNTIME/corepack"
node --version
pnpm --version
```

Expected output starts with `v24.15.0` and then prints `10.34.5`.

## Reproduce dependency installation

Use the exact command below. It does not update `pnpm-lock.yaml` and places the
pnpm store in the ignored project runtime directory:

```sh
CI=1 pnpm install --frozen-lockfile --store-dir "$CF_RUNTIME/pnpm-store"
```

On 2026-09-09 this completed for all three workspace projects, resolving 929
packages. It ran the approved `esbuild` postinstall script. pnpm reported that
it did not run scripts for `@prisma/engines`, `prisma`, `vue-demi`, and
`@scarf/scarf`, consistent with `pnpm-workspace.yaml` allowing only `esbuild`.
Do not run `pnpm approve-builds` as a blanket fix; audit and explicitly record
any change to that policy before enabling additional build scripts.

`pnpm typecheck` also passed for `@content-factory/api` and
`@content-factory/web` using this runtime.

## Local infrastructure checkpoint

An ignored `.env` was created from `.env.example` with four independent random
local passwords and mode `0600`. Its values must never be copied into logs,
issues, commits, or chat. Compose configuration validates without printing the
environment values.

The following command built the pinned local MinIO image and started only the
Content Factory services:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml build minio
docker compose --env-file .env -f infrastructure/compose.yaml up --detach
```

The split build is intentional: `minio-init` consumes the local MinIO image but
does not itself have a build definition, so a first `up --build` can try to pull
that local image before the build completes. Building `minio` once first avoids
that race.

At this checkpoint PostgreSQL, Redis, and MinIO are `healthy`; the one-shot
`minio-init` service exited with code 0. Compose created only these project
volumes:

```text
content-factory_postgres-data
content-factory_redis-data
content-factory_minio-data
```

Verify this state without revealing configuration values:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml config --quiet
docker compose --env-file .env -f infrastructure/compose.yaml ps --all
```

## Current boundary

- `tmp/runtime/`, `node_modules/`, and the pnpm store are ignored local state.
- The local `.env` and Content Factory Docker volumes are now initialized. Do
  not replace `.env` while those volumes exist: MinIO provisioning credentials
  would no longer match the persistent storage state. Use the documented
  teardown procedure only when intentionally discarding local data.
- `ffmpeg` and `ffprobe` are not installed on this WSL host. They are the
  remaining local prerequisite for the Stage 1 background cutting worker; this
  runtime setup does not install an unpinned system package manager dependency.
- This setup does not modify `package.json`, `pnpm-lock.yaml`, application
  code, schemas, or Docker configuration.
