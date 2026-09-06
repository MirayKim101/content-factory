# Stage 2d — exact editorial review, approval and metrics

Статус: implementation ready for independent review; live admission not enabled
Дата: 2026-09-06
Владелец: Backend Engineer — Editorial Approval & Metrics

## Пользовательский результат

Backend формирует один согласованный preview для `READY`-нарезки, связывая
current manual metadata/thumbnail с current assembly recipe и его `READY`
horizontal render. Оператор подтверждает точную комбинацию, а PostgreSQL
сохраняет immutable approval и snapshot времени обработки, прямой provider cost
и ручного внимания. Worker, FFmpeg и object storage при approval не запускаются.

## REST contract

- `GET /api/v1/pipeline-jobs/:cutJobId/editorial-review` — authoritative
  candidate, blockers, current/latest approval и provisional metrics;
- `POST /api/v1/assembly-renders/:renderId/editorial-approvals` — exact approval
  с обязательным `Idempotency-Key` и телом:

  ```json
  {
    "editorialRevision": 1,
    "candidateFingerprint": "64 lowercase hex characters",
    "manualAttentionMs": 245000,
    "attentionMeasurementVersion": "foreground-preview-v1"
  }
  ```

- `GET /api/v1/projects/:projectId/editorial-approvals?cursor=&limit=` —
  восстановление immutable history после reload.

Approval возвращает derived `CURRENT` либо `STALE`. Metadata/recipe revisions,
authorization, montage rights, thumbnail и render readiness проверяются при
каждом чтении без изменения historical row.

## Persistence и idempotency

Additive migration `20260906200000_editorial_approval_metrics` добавляет:

- exact immutable `EditorialApproval`;
- one-to-one `EditorialApprovalMetrics` версии `approval-metrics-v1`;
- общий globally unique `EditorialOperationRequest` ledger для approval и
  будущего Stage 2e export.

Одинаковый key и полный canonical tuple возвращают тот же approval. Тот же key
с другим render path, project/source lineage, revision, fingerprint, attention
value или operation возвращает `409`. Разные keys одной exact комбинации
сходятся на одном logical approval в serializable transaction.

## Metrics contract

Источник времени — только persisted `PipelineJob`/`JobAttempt` UTC timestamps,
`timestampBasisVersion=persisted-job-attempt-v1`. Initial queue, retry gaps,
active attempts, first-start-to-finish и calendar cut-to-assembly elapsed не
смешиваются. Missing/negative timestamps возвращают `null` и field-specific
reason; API не clamp-ит, не сортирует по wall clock и не переписывает строки
recovery.

`directProviderCostMinor=0`, `RUB`,
`costBasisVersion=local-direct-provider-cost-v1` означает только отсутствие
платных provider/API расходов. Электричество, амортизация и труд не оценены.

## Проверка implementation

Из корня repository:

```bash
corepack pnpm --filter @content-factory/api db:generate
find apps/api/src/generated/prisma -type f -name '*.ts' -exec perl -pi -e 's/[ \t]+$//' {} +
find apps/api/src/generated/prisma -type f -name '*.ts' -exec perl -0777 -pi -e 's/\n+\z/\n/' {} +
corepack pnpm --filter @content-factory/api typecheck
corepack pnpm --filter @content-factory/api lint
corepack pnpm --filter @content-factory/api test
ASSEMBLY_RECIPE_ISOLATED_TESTS=1 corepack pnpm --filter @content-factory/api exec vitest run --config vitest.integration.config.ts test/assembly-recipe-isolated.integration.spec.ts
corepack pnpm --filter @content-factory/api check:openapi
corepack pnpm --filter @content-factory/web check:openapi
corepack pnpm --filter @content-factory/api build
corepack pnpm format:check
git diff --check
```

Обе команды `find ... perl` обязательны после каждого `db:generate`: Prisma
7.10.0 генерирует пробелы в конце строк и лишние переводы строки в EOF. Это
детерминированная нормализация только generated output; повторный
`db:generate` с теми же командами оставляет тот же diff.

Isolated suite создаёт отдельные disposable PostgreSQL databases, накатывает все
migrations, сверяет migration/schema drift и удаляет базы после теста. Она не
изменяет локальную рабочую базу.

## Rollout после independent CLEAN

1. Убедиться read-only запросом, что нет active pipeline jobs, и сохранить
   backup/rollback evidence.
2. Сохранить forward-compatible API build с
   `EDITORIAL_APPROVAL_ENABLED=0` как rollback target.
3. Применить additive migration.
4. Запустить API сначала с admission off и проверить прежние source/cut/
   editorial/montage/recipe/render routes.
5. Включить preview, затем `EDITORIAL_APPROVAL_ENABLED=1`.
6. Выполнить short real review → approval → reload → stale-after-edit smoke.

До independent CLEAN запрещены live migration, runtime restart и включение
admission.

## Controlled failures и rollback

- stale/changed candidate, wrong render или incomplete metrics: `409` без
  partial writes;
- idempotency tuple/key conflict: generic `409`, не раскрывающий чужой result;
- missing target: `404`; invalid input/key/cursor: `400`; disabled admission:
  `503`;
- authorization и rights входят в blocker/stale reason и approval fail-closed.

Rollback отключает новое approval admission и возвращает сохранённый
forward-compatible admission-off API. Additive tables и historical approvals
остаются; existing media/metadata/recipe/render rows и objects не удаляются.

## Не входит

Frontend review timer/UI, background ZIP64 export, worker changes, AI, Twitch,
vertical clips, publishing, mobile и повышение concurrency. Stage 2e начинается
только после independent CLEAN и приёмки этого slice.
