# Stage 3 local acceptance

Дата: 2026-09-28

## Принятый локальный контур

- Twitch control plane: allowlist, signed EventSub inbox, reconciliation,
  delayed VOD candidates и revoke без удаления истории.
- EventSub subscription callback допускает только HTTPS:443 на публичном host
  и точном `/api/v1/twitch/eventsub`; localhost, private/shared/link-local IP,
  IPv6 loopback/ULA и другой path отклоняются до provider request.
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
- Vertical UI также получает эффективный server-side admission: при
  выключенном render flag создание новых задач заблокировано и объяснено,
  но история и подтверждение готовых результатов остаются доступны.
- `FAILED_FINAL` vertical attempt не делает исходную нарезку навсегда
  недоступной: оператор может создать новую идемпотентную попытку, а предыдущая
  запись остаётся в истории. Активный или готовый render продолжает блокировать
  дубликат.
- `.env.example` перечисляет все Stage 3 master switches default-off;
  production-like compose render с подключёнными profiles подтверждает нули
  для publishing, Twitch control/data plane и vertical rendering.
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
- Production dependency overrides закрепляют исправленные `multer 2.3.0`,
  `deepmerge-ts 8.0.0` и `mysql2 3.23.1`; `pnpm audit --prod` не находит
  известных уязвимостей.
- API responses, включая health и Swagger UI, получают единый Helmet baseline:
  CSP, HSTS, frame/referrer policy, COOP и MIME sniffing protection.
- `ai-worker` использует тот же container security baseline, что остальные
  workers: read-only root filesystem, dropped capabilities, no-new-privileges,
  bounded PID/CPU, bounded noexec tmpfs и log rotation.
- Publication, Twitch и vertical workers также имеют явные PID/CPU limits,
  45-секундный graceful stop и bounded local log rotation.
- Reconciliation loops publication, Twitch и vertical работают single-flight;
  SIGTERM прекращает новые ticks, ждёт текущий запуск и только затем закрывает
  PostgreSQL/S3, не создавая искусственную job failure при штатном rollout.
- Production API bootstrap включает Nest shutdown hooks для SIGINT/SIGTERM,
  поэтому Prisma, BullMQ, S3 и application timers получают lifecycle callbacks.
- Периодические media/montage API reconcilers работают single-flight и
  дренируют активный tick в `onModuleDestroy` до закрытия зависимостей.
- Startup reconciliation ручных source uploads abort-aware на shutdown и
  дренируется без ложной timeout/error записи.
- Editorial thumbnail startup reconciliation протягивает timeout/shutdown
  AbortSignal до S3 HEAD/DELETE и не сохраняет ложный terminal failure.
- Media, AI, publication, Twitch и vertical containers имеют единый readiness
  marker/healthcheck: stale marker удаляется до старта, готовность публикуется
  после инициализации, а shutdown снимает её до drain.
- Transcript, research, image и optional clip recovery в AI worker работают
  single-flight. Shutdown сначала закрывает очереди, затем дожидается текущих
  recovery-проходов и только после этого закрывает PostgreSQL/S3 ресурсы.
- Frame, export-scratch и media-scratch reconciliation в основном media worker
  также работают single-flight. SIGTERM синхронно останавливает новые ticks и
  abort-ит frame I/O, затем дренирует активные проверки перед закрытием БД.
- Scheduled publication reconciliation изолирует ошибку каждого intent:
  повреждённая запись не блокирует остальные due-публикации и последующие
  outcome/metrics проходы того же цикла; batch-query error остаётся видимым.
- Все захваченные remote-outcome claims начинают heartbeat до последовательного
  provider polling. Поздняя запись в batch больше не теряет двухминутный lease,
  пока ждёт предыдущую, и не может параллельно попасть второму worker.
- Metrics claims также удерживаются heartbeat с момента batch claim. Потеря
  владения или ошибка heartbeat abort-ит provider GET и запрещает старому
  worker записывать snapshot либо освобождать lease нового владельца.
- Outcome/metrics heartbeat и terminal mutations требуют не только matching
  token, но и неистёкший lease. Просроченный worker не может воскресить claim
  или записать status/snapshot до следующего reclaim; SQL проверен на runtime DB
  no-op probes с заведомо отсутствующим intent ID.
- Twitch control plane и длинный VOD data-plane import работают независимыми
  single-flight циклами. Импорт больше не блокирует Helix/EventSub ticks или
  startup readiness; graceful shutdown abort-ит активный transfer без ложного
  failure и затем дренирует оба цикла перед закрытием PostgreSQL/S3.
- Shutdown во время pending Twitch claim также fenced: новый transfer не
  стартует после SIGTERM, а уже выданный lease атомарно возвращается в `QUEUED`
  без потери attempt budget и без двухчасовой задержки recovery.
- Vertical worker применяет тот же shutdown contract к pending claim и
  активным download/FFmpeg/upload: I/O abort-ится, job и attempt атомарно
  возвращаются в очередь без ложной ошибки и расхода retry budget.
- Publication shutdown abort-ит pending provider calls и безопасные attempts
  возвращает в `QUEUED` без расхода retry budget. Если adapter уже пересёк
  remote commit boundary, его `PublicationOutcomeUnknownError` имеет приоритет:
  intent остаётся в quarantine для reconciliation и не повторяет POST.
- Status reconciliation и metrics collection также имеют внешний shutdown
  abort: read-only provider calls завершаются, все удерживаемые claims
  освобождаются, а worker не ждёт последовательные 30/60-секундные deadlines.
- Twitch control-plane shutdown signal проходит через EventSub list/create/
  delete, Helix pagination и channel reconciliation. Многостраничный проход
  прекращается немедленно и не записывает shutdown как ошибку канала.
- Все PostgreSQL-пулы worker-ролей используют единый fail-fast contract:
  подключение ограничено 5 секундами, SQL statement/query и простаивающая
  транзакция — 30 секундами. Потеря БД больше не может бессрочно удерживать
  startup, lease loop или graceful shutdown.

## Воспроизведённые проверки

```text
API:     243/243 unit tests
Publication real disposable PostgreSQL: 1/1
Worker:  289/289 unit tests
Web:     266/266 tests
Twitch ingest real PostgreSQL + MinIO: 2/2 (transfer + cross-channel fairness)
Vertical real Docker FFmpeg render/decode: 1/1
Fresh PostgreSQL migration: 43/43, 73 public tables, 0 unvalidated constraints
```

Дополнительно прошли Prisma validate/migration deploy, OpenAPI regeneration and
drift checks, API/worker/web typecheck и lint, API/worker/web production builds,
production dependency audit, Docker Compose config validation и runtime health
на API 3001/UI 3100. Порт 3000 не используется.

Web development default и runbook закрепляют порт 3100. API не открывает
отдельный CORS origin для занятого 3000: browser API идёт через same-origin
proxy. Прямой preflight с origin 3000 не получает allow-origin, а health через
3100 proxy возвращает HTTP 200.

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
