# ADR-002: Bounded parallel media pipeline

- Статус: accepted
- Дата: 2026-09-01
- Автор решения: Solution Architect — Parallel Media Pipeline
- Reviewer / approver: Business Analyst — Media Capacity Economics / owner

## Проблема и доказательства

Длинные Twitch VOD могут приходить всплеском. Расчётная оценка одного
пятичасового файла при 4–8 Mbps — примерно 9–18 GiB; десяти файлов — 90–180
GiB. Это допущение до измерения реальных источников. Последовательная обработка
может пропустить редакционное окно, а неограниченный параллельный запуск способен
исчерпать сеть, scratch disk, CPU/GPU, память или квоту AI-провайдера.

## Решение

Система принимает независимые задания сразу, сохраняет их авторитетное состояние
в PostgreSQL и выполняет параллельно только в пределах настраиваемых resource
pools. Остальные задания видимо и безопасно ожидают. BullMQ доставляет указатели
на задания, но не является источником истины.

Отдельные лимиты принадлежат ingest, FFprobe, CPU FFmpeg, GPU media, каждому AI
provider и каждой publishing platform. Scheduler учитывает global limit,
per-channel cap, priority, aging, retry budget, disk admission и provider circuit
breaker. Локальный безопасный default — один тяжёлый FFmpeg slot; архитектура и
конфигурация позволяют увеличивать его после benchmark.

Batch является операторской группой. Каждый item имеет собственные состояние,
attempts, progress и artifacts. Ошибка одного item не останавливает остальные.

## Control plane и data plane

Control plane сохраняет ADR-001: относительный `/api/v1` через same-origin edge в
NestJS. В Stage 3 большие байты используют resumable multipart data plane:

- браузер создаёт короткую `UploadSession` через API;
- части идут напрямую в object storage по короткоживущим разрешениям;
- локальный/VDS edge может same-origin проксировать `/uploads/**` напрямую в
  storage без buffering;
- для внешнего storage допустим presigned URL со строгим CORS точного origin;
- Twitch ingest worker потоково пишет multipart и одновременно считает checksum.

NestJS и Nitro не буферизуют полный файл. Незавершённые multipart sessions имеют
TTL, reconciler и lifecycle cleanup.

## Авторитетная модель

Постепенно добавить `ProcessingBatch`, `PipelineJob`, `JobAttempt`,
`UploadSession` и `UploadPart`. Job хранит stage/type, resource class, state и
desired state, priority, channel/batch, revision, idempotency key, lease,
heartbeat, progress, retry budget, safe failure и artifact lineage.

Worker захватывает job через compare-and-set lease. Duplicate queue delivery не
повторяет effect. После потери Redis reconciler восстанавливает runnable jobs из
PostgreSQL.

## Storage и admission

Object storage авторитетен для media; worker disk — только scratch. Перед
тяжёлой работой резервируется прогнозируемое место. Job не стартует ниже safety
threshold или при исчерпанном I/O budget. Retention — измеряемая политика:
исходники 7–14 дней, intermediates 1–3 дня, approved finals 30–90 дней как
начальные эксперименты, а не постоянные обещания.

## UI и API

Перед multi-job UI утвердить paginated project list, batch contracts, monotonic
revision, per-item progress и идемпотентные pause/resume/cancel/retry commands.
Batch-команды возвращают `accepted/skipped/conflict` отдельно для каждого item.

UI показывает batches и строки видео, stage, измеримый progress, queue reason,
occupied/configured slots, фильтры, partial success и exception-first view.
Frontend upload scheduler ограничивает параллельность; `Promise.all` всех файлов
запрещён. Vue Query использует один batch/list poll с revision protection. SSE
отложен и позже может быть только сигналом invalidation, а reconciliation poll
сохраняется.

## Граница MVP

Stage 1 сохраняет одиночную ручную загрузку. Сейчас фиксируются job/attempt seams,
конфигурируемая bounded concurrency и multi-project state model. Paginated list
и multi-item status добавляются до масштабирования. Twitch ingest, resumable
multipart, 10-channel scheduler, AI/publishing pools, SSE и multi-node deployment
остаются Stage 3.

## Метрики и критерии успеха

Измерять source GiB/hour, source-hours per worker-hour, queue p50/p95, peak
scratch, network, active/configured slots, retries, oldest job age, storage
GiB-days, cost/source-hour и operator minutes/approved asset.

Решение подтверждено, когда active jobs не превышают limits, scratch reservation
соблюдается, duplicate delivery создаёт один artifact, restart/Redis loss не
теряют job, per-channel cap не создаёт starvation, а память зависит от chunk и
concurrency, не от полного размера файла. Предварительное окно до 12 часов не
является SLA до измерения benchmark.

## Rollback

Снижение любого pool limit до одного сохраняет корректность и даёт
последовательное выполнение без изменения данных. Multipart data plane можно
отложить, сохранив текущий Stage 1 upload, но нельзя без admission control просто
увеличивать лимит или запускать много текущих multipart HTTP requests.
