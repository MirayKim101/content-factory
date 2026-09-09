# Queue dependency verification — 2026-09-09

Status: versions verified for the approved Stage 1 cut slice; installation and
runtime acceptance are pending. No queue is implemented by this document.

## Pinned candidates

| Package   | Version | Registry runtime requirement |
| --------- | ------- | ---------------------------- |
| `bullmq`  | `6.3.4` | Node `>=14.17.0`             |
| `ioredis` | `6.0.0` | Node `>=20.0.0`              |

The repository's Node `24.15.0` satisfies both published engine ranges. Registry
metadata for BullMQ `6.3.4` declares optional `ioredis >=5.0.0`; install the Redis
client explicitly. The local Redis image is already pinned to `8.10.1`.
These checks establish declared compatibility; the delivery must still run a
real queue/worker smoke and Redis-loss recovery before acceptance.

Read before this selection:

- [BullMQ quick start](https://docs.bullmq.io/quick-start): package installation
  and separate Queue/Worker composition.
- [BullMQ changelog](https://docs.bullmq.io/changelog): `6.3.4` published on
  September 1; v6 changes the low-level backend API.
- [Connections](https://docs.bullmq.io/guide/connections): worker connections
  require persistent retries; producer connections must fail promptly.
- [Failing fast](https://docs.bullmq.io/patterns/failing-fast-when-redis-is-down):
  disable the producer offline queue so requests do not wait for Redis recovery.
- [Redis compatibility](https://docs.bullmq.io/guide/redis-tm-compatibility/).
- [ioredis releases](https://github.com/redis/ioredis/releases): v6 requires Node
  20+ and defaults to RESP3; `protocol: 2` retains the prior wire protocol.
- [ioredis usage](https://github.com/redis/ioredis#basic-usage).

Registry verification commands:

```sh
npm view bullmq version engines dependencies --json
npm view bullmq@6.3.4 peerDependencies peerDependenciesMeta --json
npm view ioredis version engines --json
```

The official quick start uses `npm install bullmq`. In this pnpm workspace, the
implementation owner installs exact versions in the adapter-owning package with
`pnpm --filter <owning-package> add --save-exact bullmq@6.3.4 ioredis@6.0.0` and
commits the workspace lockfile. Do not modify the owner's untracked root npm
lockfile or install optional SQL queue backends.

## Project integration constraints

Use the approved Redis/BullMQ adapter behind the owned queue port. BullMQ's new
PostgreSQL backend is outside this delivery: our own PostgreSQL job state remains
authoritative and Redis contains disposable references only.

Use independent producer and worker connection settings. Best-effort publication
must have a bounded wait, preserve the committed job on failure, and avoid an
unhandled connection error. Reconciliation must recover the reference later.
Do not derive execution authority from BullMQ locks or completion alone; the
PostgreSQL attempt/lease transaction decides the winning effect.
