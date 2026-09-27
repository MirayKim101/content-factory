# Stage 3 local acceptance

Дата: 2026-09-28

## Принятый локальный контур

- Twitch control plane: allowlist, signed EventSub inbox, reconciliation,
  delayed VOD candidates и revoke без удаления истории.
- VOD data plane: default-off admission, idempotent durable intent, fenced
  lease/retry, persistent scratch, HTTP Range resume, byte fence, MP4 `ftyp`,
  SHA-256, multipart object upload и атомарный finalize.
- Автоматически созданный source имеет `NOT_REVIEWED`; downstream jobs не
  обходят ручное подтверждение прав.
- Вертикальный pipeline: exact current cut lineage, отдельный 1080×1920
  H.264/AAC render, отдельное human approval и private content delivery.
- Publication: UTC schedule, channel ownership, exact approved vertical
  lineage, idempotent state machine, LOCAL_DRY_RUN, YouTube resumable upload,
  TikTok Direct Post, unknown-remote reconciliation и metrics snapshots.
- UI показывает Twitch import progress, vertical review, расписание и provider
  statuses. При выключенном auto-ingest явно сохраняет ручную привязку.

## Воспроизведённые проверки

```text
API:     226/226 unit tests
Worker:  239/239 unit tests
Web:     245/245 tests
Twitch ingest real PostgreSQL + MinIO: 2/2 (transfer + cross-channel fairness)
Vertical real Docker FFmpeg render/decode: 1/1
Fresh PostgreSQL migration: 42/42, 73 public tables, 0 unvalidated constraints
```

Дополнительно прошли Prisma validate/migration deploy, OpenAPI regeneration and
drift checks, API/worker/web typecheck и lint, API/worker/web production builds,
Docker Compose config validation и runtime health на API 3001/UI 3100. Порт
3000 не используется.

## Fresh migration proof

Все 42 миграции применены с нуля к отдельно созданной базе
`cf_stage3_fresh_acceptance_20260928` на PostgreSQL 18.6. После deploy база
содержала 73 public-таблицы и 0 непрвалидированных constraints. Disposable база
удалена guarded exact-name командой; повторная проверка `pg_database` вернула 0. Restored runtime database в этом proof не изменялась.

## Не является локально доказанным

Реальные внешние публикации и получение байтов конкретным Twitch media gateway
не проверяются без выбранного gateway deployment и production OAuth secrets.
Это rollout/canary gate, а не причина включать небезопасный scraper или хранить
секреты в БД. Все соответствующие flags по умолчанию выключены.
