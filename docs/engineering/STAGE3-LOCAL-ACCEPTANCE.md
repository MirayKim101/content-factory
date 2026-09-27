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
- Publishing UI получает эффективные server-side capabilities без секретов;
  выключенные provider paths не выглядят доступными, а история остаётся
  читаемой в fail-closed режиме.
- Publication uploads имеют 30-минутный bounded attempt deadline, status
  reconciliation — 60-секундный deadline; lease-loss по-прежнему имеет
  приоритет и не позволяет старому worker менять durable state.
- Timeout внешнего publication attempt всегда переходит в
  `UNKNOWN_REMOTE_STATE`, а не повторяет POST; новый вызов блокируется до
  provider reconciliation даже когда remote ID ещё неизвестен.
- Общий publication deadline физически проходит через S3 identity check,
  OAuth token refresh/channel verification и все provider transport calls;
  зависший credential endpoint не обходит lease fencing.
- Для `UNKNOWN_REMOTE_STATE` без remote ID оператор может после ручной проверки
  подтвердить отсутствие публикации. Только exact boolean confirmation удаляет
  незавершённую encrypted session и переводит intent в `FAILED_FINAL`, после
  чего отдельный retry снова требует подтверждения.
- TikTok Direct Post initiation теперь считается необратимой внешней границей:
  потерянный/невалидный ответ и ошибка сохранения уже полученного `publish_id`
  переводят intent в `UNKNOWN_REMOTE_STATE`, а не повторяют POST. Однозначный
  HTTP 4xx до принятия запроса остаётся в bounded retry.
- YouTube и TikTok работают через независимые abort-aware provider pools с
  concurrency 1; очередь одного provider не потребляет permit другого. После
  трёх последовательных transient/network/5xx ошибок circuit открывается на
  60 секунд; validation errors и durable unknown-remote handoff его не открывают.
- Provider retry сохраняет отдельный `nextAttemptAt` с exponential backoff
  30/60/120 секунд и cap 15 минут; исходный publication schedule не меняется,
  API и UI явно показывают время следующей попытки.
- История публикаций загружается ограниченными cursor-страницами; оператор
  может открыть более ранние записи, а фоновое обновление не удаляет уже
  загруженную историю.
- Селекторы проектов в Twitch, vertical, publication и montage workspaces
  проходят все contract-sized cursor-страницы по 50 записей; проекты после
  первой страницы больше не исчезают из операторского UI.
- Publication channel можно отозвать из UI/API. Serializable revoke сохраняет
  историю, атомарно отменяет `SCHEDULED`/`QUEUED`, не маскирует уже начатый
  remote attempt и не допускает межпроектный revoke.
- Полный vertical attempt (download, FFmpeg и upload) ограничен двумя часами;
  timeout прерывает I/O тем же abort signal и освобождает durable lease через
  штатный bounded failure path.
- Полный Twitch VOD ingest attempt ограничен 24 часами, включая streaming
  download, hashing и multipart upload. Timeout сохраняет resumable scratch и
  переводит intent в bounded retry вместо бесконечного lease.

## Воспроизведённые проверки

```text
API:     234/234 unit tests
Publication real disposable PostgreSQL: 1/1
Worker:  259/259 unit tests
Web:     252/252 tests
Twitch ingest real PostgreSQL + MinIO: 2/2 (transfer + cross-channel fairness)
Vertical real Docker FFmpeg render/decode: 1/1
Fresh PostgreSQL migration: 43/43, 73 public tables, 0 unvalidated constraints
```

Дополнительно прошли Prisma validate/migration deploy, OpenAPI regeneration and
drift checks, API/worker/web typecheck и lint, API/worker/web production builds,
Docker Compose config validation и runtime health на API 3001/UI 3100. Порт
3000 не используется.

Publication workspace дополнительно проверен реальным Chromium render на
desktop и узком layout: проект загружается без ложной ошибки валидации,
сводные карточки и форма переходят в одну колонку, длинное имя проекта не
растягивает страницу.

Publication repository дополнительно воспроизведён на отдельной базе, созданной
из всех migration SQL: exact idempotent replay/conflict, atomic channel revoke,
session cleanup при operator-confirmed absence, retry reset и запрет ручного
absence-resolution при наличии remote ID. База удалена guarded teardown после
теста; restored runtime database не была test target.

## Fresh migration proof

Все 43 миграции применены с нуля; последний proof выполнен на отдельно созданной
базе `cf_stage3_retry_acceptance_20260929` на PostgreSQL 18.6. После deploy база
содержала 73 public-таблицы и 0 непрвалидированных constraints. Disposable база
удалена guarded exact-name командой; повторная проверка `pg_database` вернула 0. Restored runtime database в этом proof не изменялась.

## Не является локально доказанным

Реальные внешние публикации и получение байтов конкретным Twitch media gateway
не проверяются без выбранного gateway deployment и production OAuth secrets.
Это rollout/canary gate, а не причина включать небезопасный scraper или хранить
секреты в БД. Все соответствующие flags по умолчанию выключены.
