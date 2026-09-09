# Task brief — Manual editorial draft for a READY cut

## Пользовательская цель

Оператор открывает готовую нарезку, вручную сохраняет заголовок, описание,
упорядоченные теги и собственную обложку; после полного reload черновик доступен
в той же revision.

## Не входит в задачу

- реклама, intro/outro, overlay, CTA и звук;
- новый MP4 и любые FFmpeg jobs;
- preview approval, ZIP/export и AI;
- mobile UX.

## Обязательные документы

- `00-PROJECT-SUMMARY.md`
- `docs/product/MVP-ROADMAP.md`
- `docs/product/STAGE2-EDITORIAL-PACKAGE.md`
- `01-ARCHITECTURE.md`
- `ARCHITECTURE.md`
- ADR-001, ADR-002, ADR-003 и ADR-004

## Владение первого implementation pass

Backend Engineer владеет Prisma migration, модулем editorial content,
thumbnail storage/validation, REST DTO/OpenAPI и backend tests. Frontend не
меняется до фиксации контракта. Нельзя перезапускать media-worker или применять
миграцию к общей локальной БД, пока QA не подтвердит terminal state capacity
benchmark `5x3`.

## Контракт и данные

- immutable `ProcessingTemplateRevision`;
- `EditorialPackage`, привязанный к точному `READY CUT_RESULT` artifact;
- immutable `EditorialPackageRevision` с optimistic `expectedRevision`;
- private project-scoped `EditorialAsset` типа thumbnail с SHA-256 и размером;
- `POST/GET processing-templates`;
- project-scoped upload/list/content thumbnail endpoints;
- `PUT/GET pipeline-jobs/:jobId/editorial-package`;
- project list editorial packages для reload без N запросов;
- `Idempotency-Key`: тот же key/body возвращает прежний результат, другой body
  даёт `409`; stale revision даёт `409` без потери новой revision.

## Критерии приёмки

1. Два `READY` cut jobs используют одну точную revision шаблона.
2. Manual metadata и thumbnail сохраняются и восстанавливаются из PostgreSQL.
3. Неполный draft допустим, validation честно перечисляет missing fields.
4. Cross-project, non-ready и wrong-artifact обращения отклоняются fail-closed.
5. Thumbnail: только JPEG/PNG/WebP, максимум 10 MiB; SVG, fake MIME, corrupt
   dimensions и чрезмерное число pixels завершаются controlled failure с cleanup.
6. Object key не раскрывается; в logs нет title/description и другого content.
7. Исходник/CUT_RESULT/checksum не меняются и FFmpeg job не создаётся.
8. API unit/integration/contract проходят; docs и rollback обновлены.

## Команды проверки

```text
pnpm --filter @content-factory/api lint
pnpm --filter @content-factory/api typecheck
pnpm --filter @content-factory/api test
pnpm --filter @content-factory/api test:integration
pnpm --filter @content-factory/api check:openapi
```

## Риски и rollback

Основные риски — нарушение lineage, object leak после неуспешной загрузки и
lost update. Функциональный rollback скрывает routes/UI, но сохраняет additive
таблицы и objects до отдельного безопасного cleanup.

## Evidence implementer

- Изменённые файлы: additive Prisma schema/migration и generated client в
  `apps/api/prisma/**`, `apps/api/src/generated/prisma/**`; новый neutral module
  `apps/api/src/editorial-content/**`; регистрация module в
  `apps/api/src/app.module.ts`; unit/integration/contract tests в
  `apps/api/test/**`; OpenAPI JSON и generated TypeScript contract в разрешённых
  `apps/web/openapi/**` и `apps/web/app/shared/api/generated/**`.
- Фактически выполненные команды:
  `./node_modules/.bin/prisma generate`,
  `./node_modules/.bin/prisma format`,
  `./node_modules/.bin/prisma validate`,
  `../../node_modules/.bin/prettier --check <owned files>`,
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json`,
  `./node_modules/.bin/oxlint src test scripts`,
  `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -p tsconfig.build.json`,
  `node --import tsx scripts/openapi-contract.ts check ../web/openapi/openapi.json`,
  `node openapi/contract.mjs generate`, `node openapi/contract.mjs check`,
  `nuxt typecheck`, `nuxt build`, `sh -n infrastructure/minio/provision`,
  `docker compose ... run --rm minio-init`,
  `corepack pnpm --filter @content-factory/api test:integration`,
  `git diff --check`.
- Результат smoke test: Nest application собирается с новым module; 18 unit /
  contract suites (59 tests) проходят. Live Nest OpenAPI совпадает с JSON и
  generated TypeScript client; integer/array/tag ограничения проверяются exact
  contract assertions. Thumbnail tests используют реально декодируемые
  JPEG/PNG/WebP и подтверждают отказ для SVG, fake MIME, corrupt CRC/structure,
  header-only payload, недействительного VP8 frame, ненулевых reserved version
  bits VP8L, reserved flag/header bits VP8X и pixel bomb; реальные lossless VP8L
  и `VP8X + VP8L` остаются допустимыми.
- Recovery evidence: finalize ambiguity сначала перечитывает authoritative DB
  state и не удаляет READY/unknown object; failure intent сохраняется до delete.
  Startup reconciler финализирует только object с точным size/SHA metadata и
  повторяет durable `FAILED_FINAL/PENDING` cleanup. Тесты подтверждают порядок
  intent -> delete -> cleanup complete и restart invocation.
- Concurrency/auth/lineage evidence: unit tests подтверждают same-key/same-body
  replay после `P2034`, отдельный different-body conflict, отсутствие retry для
  authoritative stale CAS и bounded retry. Repository на save/get/list применяет
  policy-aware gate к exact source version; CUT_RESULT recipe/checksum/size/source
  lineage проверяются fail-closed на записи и чтении, а immutable snapshot
  защищён DB constraints. Реальный PostgreSQL/MinIO integration прошёл: 5 suites
  и 38 tests, включая editorial suite 4/4 для двух READY cuts, exact template
  revision, multipart storage/content/reload, concurrent replay/CAS,
  authorization, tampered lineage и cleanup after restart.
- Storage evidence: MinIO API policy разрешает прежний `sources/*` и отдельный
  `editorial/*`, но не bucket-wide object wildcard; anonymous policy остаётся
  `none`. Реальный thumbnail читается через project-scoped API, а прямой
  anonymous MinIO URL возвращает `403`. Policy regression закреплён unit test.
- Известные ограничения: migration была применена orchestrator только после
  terminal benchmark; этот pass миграцию повторно не применял и media-worker не
  перезапускал. Thumbnail limit — 10 MiB и 40 млн pixels. Функциональный
  rollback скрывает routes и убирает только `editorial/*` resource из policy,
  оставляя additive таблицы и private objects; физическое удаление требует
  отдельного безопасного cleanup.

## Independent review

- Reviewer: `QA Reviewer — Manual Editorial Backend Final`.
- Findings: исправлены fail-closed проверки corrupt WebP (`VP8L` version bits и
  reserved fields `VP8X`) и отсутствовавшее least-privilege разрешение MinIO
  для private `editorial/*` objects.
- Re-check: `CLEAN`; policy unit `1/1`, editorial integration `4/4`, полный API
  integration `38/38`, unit/contract `59/59`, lint, typecheck, build, Prisma,
  OpenAPI и diff checks passed. Live policy не содержит bucket-wide object
  write, anonymous access остаётся закрытым.
