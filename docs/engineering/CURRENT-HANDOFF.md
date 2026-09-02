# Content Factory — current handoff

Обновлено: 2026-09-02
Ветка: `main`
Часовой пояс владельца: `Asia/Novosibirsk (UTC+7)`
Последний готовый commit: `c65de91 perf(media): add reproducible fast cut recipe`

## Готово

- локальные PostgreSQL, Redis и private MinIO;
- ручная загрузка одного разрешённого MP4 через Nuxt SPA;
- same-origin `/api/v1` routing без Nitro BFF (ADR-001);
- PostgreSQL metadata, MinIO object, SHA-256, lineage и safe DTO;
- generated OpenAPI contract и live drift check;
- bounded parallel media pipeline (ADR-002);
- **Stage 1 manual cutting завершён и получил independent review `CLEAN`:**
  - `/cuts?projectId=...` с browser player;
  - кнопки установки начала/конца и точные `startMs/endMs`;
  - несколько независимых segments в одном submit;
  - один `PipelineJob`, `JobAttempt` и отдельный MP4 на каждый segment;
  - PostgreSQL-authoritative state, BullMQ reference delivery и reconciliation;
  - Docker media worker, FFprobe/FFmpeg, concurrency default `1`;
  - lease/heartbeat/retry, attempt-aware deliveries и stale-worker protection;
  - post-encode video/duration validation;
  - attempt-specific result keys и durable orphan cleanup/retry;
  - status polling, safe failure, source playback и result download с Range;
  - result checksum, size, duration, recipe/tool versions и lineage.

## Фактическая проверка Stage 1 cutting

- API unit: `26/26`;
- worker unit: `10/10`;
- web: `29/29`;
- contracts: `2/2`;
- API integration: `17/17`;
- PostgreSQL worker recovery integration: `3/3`;
- format, lint, typecheck, OpenAPI drift и `git diff --check`: passed;
- четыре Prisma migration применены, schema up to date;
- Docker `media-worker` healthy, FFmpeg/FFprobe `5.1.9-0+deb12u1`;
- реальный 6-секундный H.264 source дал два независимых READY MP4:
  - `500–2400ms` -> `1.900000s`, SHA-256
    `b5bd45cda75307a68ea79abad53fc746ac48f89c0784a8e07a23a8a6af65fcaa`;
  - `3000–5500ms` -> `2.500000s`, SHA-256
    `9070e0b2661ab3f969866034eb387de85414ca8bcd7032807aba6aaf30de6923`;
- same-key replay не создаёт дубликаты; changed payload -> `409`;
- invalid bounds -> `422`; unsatisfiable Range -> safe `416`;
- corrupted structurally valid source -> terminal `FAILED_FINAL`;
- expired attempt/replay/collision/crash-after-upload/delete-retry scenarios
  воспроизведены; stale attempt не изменяет authoritative result.

## Локальная инфраструктура

На момент handoff Docker Compose поднят:

- PostgreSQL healthy на `127.0.0.1:5432`;
- Redis healthy на `127.0.0.1:6379`;
- MinIO healthy на `127.0.0.1:9000/9001`;
- `media-worker` healthy, без host port;
- `minio-init` ожидаемо завершён как one-shot с exit `0`.

MinIO volume занимает около `3.6 GiB`, доступно около `847 GiB`. Большой
загруженный `video-test.mp4` и все существующие objects не удалялись.

API и Nuxt после автоматических QA smoke могли быть остановлены. Перед показом
проверить порты `3001/3000` и запустить команды из
`docs/infrastructure/local-development.md`.

## Сохранённый большой источник

`/Users/mirai/Downloads/video-test.mp4` — `3 813 099 228` bytes, около двух
часов Full HD. Не изменять, не перемещать и не добавлять в Git. Не загружать
повторно без необходимости. Persistent MinIO source не удалять без явного
решения владельца.

## Принятые, но отложенные работы

1. Реальный клиентский upload progress: bytes/total, percent, speed, ETA и
   отдельная неизмеримая server-finalization стадия.
2. Удаление per-upload правового checkbox и additive source authorization model:
   новые sources `NOT_REVIEWED`, legacy `CLEARED/LEGACY_ATTESTATION`.
3. Список проектов и безопасное удаление проекта/artifacts.

Текущий `rightsConfirmed` контракт не изменялся в cutting slice; нельзя скрыть
checkbox и продолжать автоматически записывать ложное подтверждение.

## Следующий продуктовый шаг

Stage 1 manual upload/cut/status/download доказан. Следующий bounded slice перед
расширением editorial pipeline: project list и сохранённый source selection,
чтобы пользователь мог без ручного UUID возвращаться к нескольким загруженным
видео и их независимым jobs/results. Затем выполнить отложенный upload-progress

- source-authorization slice и переходить к Stage 2 overlays/packaging по
  `docs/product/MVP-ROADMAP.md`.

Не добавлять Twitch, AI highlight detection, вертикальные clips, публикацию или
analytics раньше соответствующего Stage 3 slice.
