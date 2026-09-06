# Stage 2e — background editorial export package

Статус: implementation ready for independent review; live migration/admission not enabled
Дата: 2026-09-06
Владелец: Backend Engineer — Editorial Export Package

## Пользовательский результат

Current exact editorial approval создаёт durable background job. Existing worker
потоково собирает один private deterministic ZIP64 без перекодирования видео и
без full-file buffers. После restart/reload состояние восстанавливается из
PostgreSQL, а current READY package скачивается через bounded Range endpoint.

## REST и persistence contract

- `POST /api/v1/editorial-approvals/:approvalId/exports` — `202`, обязательный
  globally unique `Idempotency-Key` и canonical exact approval tuple;
- `GET /api/v1/editorial-exports/:exportId` — persisted job/result/progress;
- `GET /api/v1/projects/:projectId/editorial-exports?cursor=&limit=` — history;
- `GET /api/v1/editorial-exports/:exportId/content` — private current READY
  archive, single bounded Range/206 и safe attachment filename.

Migration `20260906230000_editorial_export_package` добавляет immutable
`EditorialExportIntent`, `EditorialExportResult`, exact export relation/job,
artifact role, progress enum values и durable attempt scratch identity. Intent,
job и queued attempt создаются атомарно; enqueue происходит после commit.

## Archive и recovery contract

Archive содержит ровно пять server-owned root entries: video, thumbnail,
human-readable metadata, machine-readable metadata и manifest. MP4/thumbnail
пишутся методом STORE. Input size/SHA проверяются во время чтения; manifest
хеширует exact четыре payload entries и исключает себя/outer ZIP. Outer archive
size/SHA сохраняются в artifact/result.

До первой записи attempt создаёт private `0700` scratch directory и `0600`
marker с hash lease identity, но без token/object key. Durable reservation
записывается под active lease. Startup/periodic reconciliation fail-closed
сохраняет live/unknown directories, удаляет только confirmed inactive после
grace и перестраивает admission accounting одновременно из local markers и
PostgreSQL active reservations, включая reservation без marker. Ошибка чтения
durable reservations блокирует startup accounting вместо предположения, что
scratch пуст. Уникальный attempt object и exact finalization fence исключают
duplicate READY result.

Export archive загружается одним потоковым `PutObject`, а не multipart upload:
hard kill не оставляет незавершённые multipart parts без durable upload ID.
Atomic upload ограничен `5_000_000_000` bytes; превышение даёт controlled
terminal `EXPORT_SINGLE_UPLOAD_LIMIT_EXCEEDED`. Реальный ZIP64 fixture чуть
больше 4 GiB остаётся внутри этого предела.

## Воспроизводимая проверка

Из корня repository:

```bash
corepack pnpm --filter @content-factory/api db:generate
find apps/api/src/generated/prisma -type f -name '*.ts' -exec perl -pi -e 's/[ \t]+$//' {} +
find apps/api/src/generated/prisma -type f -name '*.ts' -exec perl -0777 -pi -e 's/\n+\z/\n/' {} +
corepack pnpm --filter @content-factory/api typecheck
corepack pnpm --filter @content-factory/api lint
corepack pnpm --filter @content-factory/api test
ASSEMBLY_RECIPE_ISOLATED_TESTS=1 corepack pnpm --filter @content-factory/api exec vitest run --config vitest.integration.config.ts test/assembly-recipe-isolated.integration.spec.ts --testTimeout=120000 --hookTimeout=120000
corepack pnpm --filter @content-factory/worker typecheck
corepack pnpm --filter @content-factory/worker lint
corepack pnpm --filter @content-factory/worker test
ASSEMBLY_REPOSITORY_ISOLATED_TESTS=1 corepack pnpm --filter @content-factory/worker exec vitest run --config vitest.integration.config.ts test/assembly-repository-isolated.integration.spec.ts --testTimeout=120000 --hookTimeout=120000
EXPORT_ZIP64_LARGE_TESTS=1 corepack pnpm --filter @content-factory/worker exec vitest run --config vitest.integration.config.ts test/streaming-zip64-package-exporter.integration.spec.ts --testTimeout=180000 --hookTimeout=180000
corepack pnpm --filter @content-factory/api check:openapi
corepack pnpm --filter @content-factory/web check:openapi
corepack pnpm --filter @content-factory/api build
corepack pnpm --filter @content-factory/worker build
corepack pnpm format:check
git diff --check
```

Isolated suites создают и удаляют только databases с защитным test prefix. Large
ZIP64 test создаёт disposable sparse input чуть больше 4 GiB во временной папке,
проверяет archive внешним `unzip` reader и удаляет fixture. Он не входит в
обычный быстрый unit run. Worker isolated suite запускает настоящий
`ProcessMediaJob` с production `StreamingZip64PackageExporter`, проверяет
закрытую ZIP64 central directory и выполняет `SIGKILL` на реальной pre-upload
границе. Затем тест проходит lease expiry, reservation rebuild, orphan cleanup
и attempt 2 через новый `ProcessMediaJob`, проверяя единственный READY
artifact/result и единственный uploaded object. В той же migrated database тест
сначала собирает, а затем запускает `dist/main.js` API и worker с
`--verify-admission-off-rollback` и `EDITORIAL_EXPORT_ENABLED=0`. Эти бинарники
читают terminal export rows, не dispatch/claim их, выполняют startup scratch
reconciliation и прежние source/cut/editorial/montage/recipe/render
compatibility/claim paths.

## Rollout и rollback после independent CLEAN

1. Сохранить forward-compatible API/worker binaries при
   `EDITORIAL_EXPORT_ENABLED=0`.
2. Read-only проверить active jobs, backup evidence и private storage/scratch.
3. Применить additive migration только по отдельному owner-approved runbook.
4. Сначала запустить capable worker и проверить startup capability
   `EXPORT_EDITORIAL_PACKAGE`; затем API/frontend.
5. Включить `EDITORIAL_EXPORT_ENABLED=1`, выполнить short export, controlled
   tampered-input failure и approved 30-minute package.
6. Для rollback выключить admission, drain/controlled-finalize export jobs и
   вернуть только forward-compatible admission-off binaries. Historical rows и
   objects сохранить; pre-migration worker не использовать.

## Не входит

Frontend export UI, live migration/restart/jobs, AI, Twitch, vertical clips,
publishing, retention UI, отдельная queue/service и повышение concurrency.
