# Stage 2a — Montage assets

Статус: implementation authorized; ADR-005 accepted, 2026-09-03.

## Результат и граница

Для проекта загрузить ADVERTISEMENT, INTRO, OUTRO (MP4) или BANNER (image),
увидеть проверку/готовность/ошибку, после reload открыть READY resource.
Без assembly recipe, render, AI, публикации или изменений текущего editor.
Следующий slice 2b задаёт порядок и времена вставок.

## Контракт

Префикс `/api/v1/projects/:projectId/montage-assets`:

- POST multipart file/kind, Idempotency-Key; 202 после durable upload finalization
  и probe intent (для проверенного BANNER допускается сразу READY).
- GET с kind/cursor/limit; GET `/:assetId`; GET `/:assetId/content` (READY only,
  MP4 Range). Без DELETE/replacement/remote URLs.
- DTO: id, projectId, kind, state revision, status, originalFilename,
  contentType, sizeBytes:string, sha256, nullable width/height/durationMs/hasAudio,
  nullable probeJobId/probe status+failure, timestamps. Не раскрывать object keys.
- Состояния UPLOADING/PROBE_PENDING/READY/FAILED_FINAL; новый upload создаёт
  immutable identity, revision отражает состояние, не замену файла.

Консервативные MVP limits: MP4 256 MiB, duration 1..180000ms; один H.264 video,
0..1 AAC audio, до 3840×2160 и 60fps. Unsupported rotation/layout — явная
ошибка. BANNER JPEG/PNG/WebP, 10MiB/40M pixels, без SVG/animation. Показать лимиты
в UI до выбора. Длинная рекламная интеграция требует отдельного пересмотра limit.

## Lifecycle и invariants

Streaming hash/staging, без full MP4 Buffer. Bounded upload admission и свободное
staging space. Durable intent до private write; exact size/checksum, затем
транзакционно probe job. Worker резервирует scratch и читает asset, не основной
VOD. Idempotency fingerprint включает весь значимый payload. Network/storage
failures retryable; invalid media/checksum/limits terminal. Lease fencing,
durable cleanup и ambiguity reread обязательны. Повреждённый ресурс не блокирует
следующий. Авторизация и asset-scoped rights evidence по ADR-005; local-auto без
дополнительного подтверждения, manual fail-closed.

## Acceptance

1. Unit/integration/OpenAPI: happy image/video, limit/MIME/corruption,
   cross-project/authorization denial, idempotency replay/conflict.
2. Worker: duplicate delivery, restart/lease expiry, stale finalization,
   Redis loss и checksum mismatch без повторных logical effects.
3. Existing source/cut/thumbnail tests remain passing; no render jobs.
4. Browser после freeze contract: upload status, READY content/Range,
   controlled error и reload identities. Pending нельзя использовать как READY.
5. Lint/typecheck/format, integration on isolated DB, independent actual-diff
   review. Runtime smoke только после drain действующего capacity batch.

## Ownership и порядок

Один Backend Engineer: API/schema/migration, worker ports/handler, contracts и
generated client, backend/worker tests. Frontend начинает после freeze OpenAPI,
владеет только новым montage feature/adapter/tests. Независимый reviewer не
исправляет проверяемый код. Live migrations/worker restart/infra policy changes
запрещены до согласования с root/DevOps: сейчас работает capacity batch.
Изолированные tests не очищают локальную пользовательскую БД/MinIO.
Новые зависимости не устанавливать без docs/review.

## Rollback

Скрыть routes/UI и отключить новое admission; drain новых jobs перед откатом
worker. Не удалять additive data/private resources; SOURCE/CUT_RESULT сохраняются.
