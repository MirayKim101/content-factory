# Task brief — Stage 1 video cutting

Статус: completed, independent review CLEAN
Дата: 2026-09-02

## Пользовательская цель

Пользователь открывает уже загруженный MP4, задаёт один или несколько отрезков
точными `startMs`/`endMs`, запускает фоновую обработку, видит адресный статус и
controlled failure каждого отрезка, а затем скачивает отдельный воспроизводимый
горизонтальный MP4 для каждого успешно обработанного отрезка.

Решение владельца от 2026-09-02: отрезки не склеиваются. Один segment создаёт
один независимый `PipelineJob` и один независимый result artifact, пригодный для
последующей отдельной загрузки на YouTube.

## Не входит в задачу

- Twitch, AI highlight detection и вертикальные клипы;
- баннеры, intro/outro, публикация и analytics;
- multi-upload и resumable multipart ingestion;
- полный draggable timeline и thumbnails;
- удаление проектов или MinIO volume;
- реализация отложенного source-authorization и upload-progress среза.

## Обязательные документы

- `AGENTS.md`, `00-PROJECT-SUMMARY.md`;
- `01-ARCHITECTURE.md`, `ARCHITECTURE.md`;
- `docs/product/MVP-ROADMAP.md`;
- ADR-001 и ADR-002;
- `docs/engineering/CURRENT-HANDOFF.md`.

## Разрешённая область изменений

- `apps/api/**` для versioned REST contract, PostgreSQL authoritative job state,
  BullMQ dispatch/reconciliation и result download;
- новый `apps/worker/**` для independently runnable FFprobe/FFmpeg worker;
- `apps/web/**` для player-based timestamp UX, status/failure и download;
- workspace manifests/lockfile только для необходимых pinned dependencies;
- affected docs and tests.

Не менять infrastructure topology и соседние product modules. Один implementer
владеет всем срезом; другие агенты до review не редактируют его файлы.

## Критерии приёмки

1. UI использует встроенный video player, кнопки «Установить начало/конец»,
   редактируемые поля и список отрезков; контракт хранит integer `startMs/endMs`,
   где `0 <= startMs < endMs <= probed duration`. Каждый segment создаёт
   отдельный job и отдельный MP4; склейка segments запрещена в этом срезе.
2. HTTP request только валидирует intent, атомарно сохраняет PostgreSQL
   `PipelineJob` и первую `JobAttempt`, затем передаёт reference в BullMQ; FFmpeg
   не выполняется внутри request.
3. Job имеет versioned payload, idempotency key, state/revision, retry budget,
   lease/heartbeat, safe failure code/message, progress и recipe version.
4. Локальный media concurrency configurable и по умолчанию равен одному;
   модель не предполагает единственную глобальную job.
5. Worker restart-safe: duplicate delivery/повтор после сбоя не создаёт второй
   logical output; Redis loss допускает reconciliation из PostgreSQL.
6. Worker проверяет source через FFprobe, режет MP4 через FFmpeg, сохраняет result
   в object storage и PostgreSQL с checksum, size, content type, lineage,
   source/recipe/FFmpeg versions. Временные файлы очищаются.
7. UI poll адресован job ID и защищён monotonic revision; показывает queued,
   processing, measurable progress (только если реально измерим), ready и safe
   final error.
8. Ready result скачивается через безопасный API endpoint как MP4. Object key и
   внутренние storage credentials не раскрываются.
9. Неверные таймкоды и повреждённый source завершаются контролируемо; job не
   остаётся бесконечно pending/processing.
10. Существующая загрузка, idempotency и OpenAPI drift checks не регрессируют.
11. Документация содержит запуск API/web/worker, smoke, failure reproduction и
    rollback/forward-fix migration guidance.

## Команды проверки

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @content-factory/api test:integration
pnpm --filter @content-factory/api check:openapi
pnpm --filter @content-factory/web check:openapi
```

Дополнительно: ffprobe input/output, длительность output в заданном допуске,
browser happy-path smoke и controlled failures для invalid timestamps и
повреждённого MP4; retry/duplicate/restart/reconciliation evidence.

## Риски и rollback

- Риск: потерянная job, duplicate output, зависший lease, неконтролируемый
  FFmpeg resource use или несовместимая additive migration.
- Rollback: остановить worker и создание новых cut jobs; additive job/artifact
  данные сохранить для forward-fix, не удалять исходники и MinIO volume.

## Evidence implementer

- Implementer: `Backend Engineer — Stage 1 Video Cutting`.
- Изменённые поверхности: additive Prisma migration/generated client;
  `apps/api/src/media-pipeline/**`; safe S3 range streaming; pure
  `packages/contracts` job reference v1; independently runnable `apps/worker`;
  generated OpenAPI; Nuxt `/cuts` FSD screen, polling and download; tests and
  local runbook.
- Выполненные команды: Prisma generate/migrate; workspace typecheck; workspace
  unit tests; API integration suite с PostgreSQL/Redis/MinIO; generated OpenAPI;
  targeted worker tests. На implementer pass: 2 contract, 22 existing/new API
  unit, 4 worker, 23 web и 15 API integration tests после добавления lease
  recovery scenario (финальный полный rerun фиксируется ниже/в handoff).
- Smoke/failure evidence: integration создаёт два независимых PipelineJob и
  первые JobAttempt атомарно, повторяет неизменённый request без дублей,
  отклоняет изменённый payload и out-of-duration bounds без job; expired lease
  возвращается в `RETRY_WAIT`; worker unit подтверждает duplicate no-op,
  attempt-specific immutable result key, retryable infrastructure failure и
  cleanup path.
- QA P1 rework: source/result с диапазоном за пределами авторитетного размера
  возвращают безопасный `416` с `Accept-Ranges: bytes`,
  `Content-Range: bytes */<size>` и структурированным телом без S3 details;
  `InvalidRange` нормализуется на границе storage adapter. Integration-run
  использует уникальное имя BullMQ queue, поэтому штатная команда прошла при
  отдельном live worker: 23 API unit, 9 worker unit и 17 API integration tests.
- Release-blocking recovery rework: heartbeat стартует сразу после claim и
  abort-ит download/probe/cut/upload при потере lease; BullMQ delivery identity
  включает номер следующей PostgreSQL attempt. PostgreSQL race integration
  воспроизводит expired attempt A, recovery в attempt B, терминальный `READY`,
  authoritative B bytes/checksum и удаление orphan A. Перед публикацией output
  отдельно проверяется FFprobe: finite duration, video stream и допуск
  `max(250 ms, two frames)`. Добавлены OpenAPI Range/200/206/416 assertions и
  component coverage queued/processing/ready/failure/revision/download/clone.
- Final recovery hardening: idempotent replay и dispatcher сверяют exact
  delivery attempt с PostgreSQL, поэтому `PROCESSING`/terminal job не резервирует
  будущую попытку, а completed/failed BullMQ collision очищается только для
  действительно runnable attempt. Additive migration хранит в `JobAttempt`
  attempt-specific `outputObjectKey` и durable cleanup intent до upload.
  Reconciliation использует CAS по `updatedAt`, повторяет delete после ошибки и
  исключает source/authoritative READY object. PostgreSQL integration покрывает
  crash-after-upload, restart cleanup и delete-failure → subsequent success.
- Известные ограничения: в текущем host PATH нет `ffmpeg`/`ffprobe`, поэтому
  реальное перекодирование, browser playback/download и ffprobe output-duration
  smoke отложены в отдельный DevOps runtime slice. Код не скрывает blocker:
  отсутствующий binary приводит к controlled failure/retry budget, а не к
  бесконечному processing. UI component-level state matrix проверена частично;
  требуется independent reviewer и browser smoke после установки runtime.

## Independent review

- Reviewer: `QA Reviewer — Stage 1 Video Cutting Final`.
- Findings: initial review found unsafe lease recovery, shared result keys,
  missing post-encode validation, incomplete streaming OpenAPI, premature
  future-attempt dispatch on idempotent replay and non-durable orphan cleanup.
- Re-check: `CLEAN`. Reviewer reproduced `PROCESSING_REPLAY_NO_FUTURE_DELIVERY`,
  PostgreSQL recovery `3/3`, API integration `17/17`, unit/component suites,
  format/lint/typecheck/OpenAPI/diff checks, migrations and healthy Docker
  worker. QA additionally produced two independent MP4 files from one source,
  verified exact durations/checksums/downloads and controlled corrupt-source
  failure.
