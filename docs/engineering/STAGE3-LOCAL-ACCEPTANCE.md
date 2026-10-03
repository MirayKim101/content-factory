# Stage 3 local acceptance

Дата: 2026-09-28

## Принятый локальный контур

- Twitch control plane: allowlist, signed EventSub inbox, reconciliation,
  delayed VOD candidates и revoke без удаления истории.
- Точный повтор подписанного durable EventSub notification/revocation
  подтверждается до freshness/channel admission, поэтому поздний retry Twitch
  не создаёт дубль и не получает ложный отказ после revoke. Тот же message ID с
  другим payload остаётся конфликтом, а новые сообщения проходят обычные
  freshness и channel-state проверки.
- EventSub subscription callback допускает только HTTPS:443 на публичном host
  и точном `/api/v1/twitch/eventsub`; localhost, private/shared/link-local IP,
  IPv6 loopback/ULA и другой path отклоняются до provider request.
- EventSub subscription type/version берутся из подписанного JSON payload;
  переданные отдельно unsigned headers разрешены только при точном совпадении.
  Их подмена не может изменить семантику сохранённого online/offline события.
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
- Создание и ручной retry публикации повторно проверяют current source,
  authorization, cut/export/render artifact и approval lineage в SERIALIZABLE
  транзакции. Устаревший результат не попадает в очередь даже если раньше был
  допустим; worker повторяет ту же fail-closed проверку перед provider call.
- Publication schedule contract принимает только RFC3339 timestamp с явным
  `Z` или numeric UTC offset. Date-only и timezone-less значения отклоняются,
  поэтому timezone production host не может незаметно сдвинуть запуск.
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
- Тот же deadline/lease-loss signal передаётся в каждое ranged-чтение media из
  S3 для YouTube и TikTok; зависшее получение очередного chunk прерывается при
  shutdown, timeout или утрате worker claim.
- Для `UNKNOWN_REMOTE_STATE` без remote ID оператор может после ручной проверки
  подтвердить отсутствие публикации. Только exact boolean confirmation удаляет
  незавершённую encrypted session и переводит intent в `FAILED_FINAL`, после
  чего отдельный retry снова требует подтверждения.
- TikTok Direct Post initiation теперь считается необратимой внешней границей:
  потерянный/невалидный ответ и ошибка сохранения уже полученного `publish_id`
  переводят intent в `UNKNOWN_REMOTE_STATE`, а не повторяют POST. Однозначный
  HTTP 4xx до принятия запроса остаётся в bounded retry.
- Сохранённая TikTok recovery session возобновляется до mutable creator/consent
  preflight: после получения `publish_id` изменение текущих capabilities не
  может удалить recovery state или ошибочно объявить возможный remote post
  terminal. Consent всё ещё строго проверяется перед первой initiation.
- Provider status `FAILED` для сохранённой TikTok session классифицируется как
  definitive permanent outcome, а не расходует retry budget повторными
  upload/status attempts.
- Потеря publication lease или shutdown во время самого TikTok initiation не
  отменяет этот remote-commit fence: неоднозначный abort имеет приоритет над
  lease recovery и остаётся в `UNKNOWN_REMOTE_STATE` до ручной/provider сверки.
- Stale external `PROCESSING` без сохранённой resumable provider session больше
  не reclaim-ится для повторного POST. После восстановления БД repository
  атомарно переводит такую попытку в `UNKNOWN_REMOTE_STATE`; session-backed
  YouTube/TikTok transfer по-прежнему безопасно возобновляется.
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
- Pre-aborted vertical attempt не запускает FFmpeg; abort race между spawn и
  регистрацией listener закрыт немедленной повторной проверкой signal, поэтому
  rollout/lease-loss не оставляет бесконтрольный encode-процесс.
- После длительного FFmpeg/upload vertical worker повторно проверяет exact
  source, authorization, cut artifact и render contracts в той же SERIALIZABLE
  транзакции, где создаётся результат. Устаревший lineage завершается как
  `FAILED_FINAL`, а уже загруженный orphan удаляется вызывающим процессом.
- Перед vertical upload exact object key сохраняется в `JobAttempt` как durable
  cleanup intent. Если DB-finalize теряет ACK, worker сначала сверяет exact
  job/intent/object/size/SHA: подтверждённый commit сохраняет объект, доказанный
  rollback делает bounded compensating delete, а недоступная БД оставляет
  объект и cleanup marker штатному reconciler вместо небезопасного удаления.
- Shutdown после подготовки vertical output сохраняет pending marker, снимает
  lease без расхода retry budget и блокирует повторный claim того же ordinal до
  завершения cleanup. Три последовательных shutdown/reconcile цикла проверены
  на disposable PostgreSQL без ложного `FAILED_FINAL`.
- Диагностический stderr длительного vertical FFmpeg render хранится как
  кольцевой хвост максимум 4000 символов; многочасовой progress output не может
  неограниченно увеличивать heap worker’а.
- Полный Twitch VOD ingest attempt ограничен 24 часами, включая streaming
  download, hashing и multipart upload. Timeout сохраняет resumable scratch и
  переводит intent в bounded retry вместо бесконечного lease.
- Если Twitch object upload завершён, но fenced DB-finalize отклонён или
  откатывается, worker compensating-delete удаляет orphan из object storage.
  Проверенный локальный scratch сохраняется для безопасного следующего claim.
- Потерянный PostgreSQL ACK после фактически успешного Twitch `COMMIT` сначала
  сверяется по exact intent/project/object/size/SHA lineage. Подтверждённый
  результат сохраняет referenced object; при недоступной DB deterministic
  object и scratch остаются для безопасного recovery, а не удаляются вслепую.
- Compensating delete для Twitch и vertical orphan ограничен отдельным
  30-секундным deadline. Недоступный object storage не удерживает worker за
  пределами graceful-stop после уже отклонённой DB-finalization.
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
- Provider-specific rollback применяется до PostgreSQL claim. Intent платформы
  без admitted adapter не переходит в `PROCESSING`, не становится ложным
  `FAILED_FINAL` и не теряет resumable provider session; defensive race fallback
  возвращает claim без расхода retry budget.
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
- Отзыв Twitch channel закрывает API admission для нового VOD import и
  операторского retry; worker независимо требует `ENABLED` при claim. Уже
  сохранённая история остаётся доступной.
- Revoke во время активного Twitch transfer обнаруживается heartbeat: intent
  атомарно возвращается в `QUEUED` без расхода attempt budget. DB-finalize ещё
  раз блокирует одновременно intent и channel row, поэтому concurrent revoke
  имеет однозначный порядок и не создаёт Project/Source/Artifact после отзыва,
  даже если multipart upload успел завершиться.
- Delayed VOD candidate продвигается в `READY` только пока связанный Twitch
  channel остаётся `ENABLED`; revoke во время задержки не создаёт новый ingest
  intent, а повторное включение сохраняет возможность штатно продолжить.
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
- Тот же shutdown signal проходит через получение и повторное обновление
  Twitch app access token. Worker не ждёт отдельный OAuth timeout перед drain,
  а коалесцированный token cache не сохраняет результат отменённого запроса.
- Twitch OAuth, Helix и EventSub запрещают HTTP redirects на credentialed
  запросах; app secret и bearer token не могут быть перенесены fetch-клиентом
  на ответивший redirect endpoint.
- Тот же запрет применяется к Google/YouTube, TikTok и OpenAI: OAuth secrets,
  bearer tokens и media chunks не следуют за HTTP redirect. Разрешённые
  resumable upload URL по-прежнему принимаются только после host allowlist.
- Реализованный unit-проверенный `/cuts` создаёт clip-generation intent только после локального разбора
  ordered SRT/VTT cues и отдельного явного согласия на передачу транскрипта.
  Ручная нарезка не зависит от feature flag или provider-а.
- AI clip worker в unit-контракте передаёт provider-вызову `AbortSignal`, продлевает fenced lease
  heartbeat-ом и на shutdown возвращает intent в `QUEUED` с восстановлением
  attempt budget. `.env.example` и compose задают этот путь default-off без
  committed secret.
- Clip-generation PostgreSQL recovery/fencing входит в baseline `12/12`: три
  shutdown подряд не расходуют budget, heartbeat продлевает lease, concurrent
  reclaim блокирует stale finalize, две provider errors дают terminal state,
  а intent другого provider, model или prompt остаётся `QUEUED` без вызова
  неверного adapter/revision.
  Браузерная проверка enabled/disabled/idempotent-retry/manual-fallback
  выполнена на 1440/390 px с перехваченными API writes (см. ниже).
- Clip-generation API persistence `2/2` на PostgreSQL подтверждает exact
  idempotent replay, conflict при изменённом payload и отсутствие intent при
  missing external-transfer consent либо local-auto authorization.
- `LOCAL_FIXTURE` допускается только при `DEPLOYMENT_PROFILE=local` и не делает
  сетевых вызовов. Реальный restored-runtime smoke на API `3001` прошёл путь
  API → Redis → отдельный AI worker → PostgreSQL: intent перешёл `QUEUED` →
  `READY`, сохранил два deterministic suggestions, exact create и acceptance
  вернули прежние IDs, изменённый payload получил HTTP 409, а acceptance создал
  два независимых cut job. Временные Project/Source/Intent/Suggestions/
  Acceptance/CutRequest/PipelineJob удалены, остаточные счётчики равны нулю.
  Это orchestration evidence, а не проверка качества внешнего AI provider.
  Fixture возвращает `confidenceBasisPoints=0`; provider-reported snapshot
  model не может заменить durable requested model из fingerprint.
- Custom `OPENAI_BASE_URL`, получающий API key и transcript, валидируется до
  старта worker: внешний endpoint обязан быть HTTPS без credentials/query/hash;
  HTTP допускается только для loopback в explicit local deployment profile.
- OAuth access-token cache YouTube/TikTok привязан одновременно к внутреннему
  channel ID и immutable provider identity. Смена external channel ref не может
  повторно использовать токен ранее выбранного аккаунта.
- Все PostgreSQL-пулы worker-ролей используют единый fail-fast contract:
  подключение ограничено 5 секундами, SQL statement/query и простаивающая
  транзакция — 30 секундами. Потеря БД больше не может бессрочно удерживать
  startup, lease loop или graceful shutdown.

## Воспроизведённые проверки

```text
API:     269/269 unit tests (Node 24.15.0, 20 s deadline for subprocess OpenAPI tests)
Readiness HTTP fixture: 3/3
Readiness real read-only PostgreSQL/Redis/S3: 4/4 (blackhole timeout + recovery)
Contracts: 23/23 unit tests
Publication real disposable PostgreSQL: 1/1
Clip-generation API real PostgreSQL: 3/3 (including disabled rollback history/read-write fence)
Worker:  342/342 unit tests
Worker lease recovery real PostgreSQL: 12/12
Web:     277/277 tests
Twitch ingest real PostgreSQL + MinIO: 2/2 (transfer + cross-channel fairness)
Vertical real Docker FFmpeg render/decode: 1/1
Fresh PostgreSQL migration: 45/45, 74 public tables, 0 unvalidated constraints
```

Дополнительно прошли Prisma validate/migration deploy, OpenAPI regeneration and
drift checks, API/worker/web typecheck и lint, API/worker/web production builds,
исторический production dependency audit, Docker Compose config validation и runtime health
на API 3001/UI 3100. Порт 3000 не используется.

На 2026-10-03 результат security audit изменился: после patch обновлений обоих
графов остаются два high без upstream fix (node-forge GHSA-86w9-cpqp-85rv,
braces GHSA-vfj7-8cjw-p6xm). Полный `pnpm audit --audit-level moderate` и
production-classified `pnpm audit --prod --audit-level moderate` завершаются
ненулевым кодом. Это release blocker, не принятый риск. Исторические зелёные
audit results выше/ниже не являются текущей security приёмкой.

Новый source CI gate дополнительно проверен локально: все workspace quality
checks и сборки, 45 fresh migrations, clip/publication API 4/4, worker recovery
12/12. Реальная multipart PostgreSQL/MinIO приёмка после multer 2.4.0: 12/12,
включая oversized 413, malformed/disconnect cleanup, concurrent idempotency,
recovery и controlled cleanup failure. Test-only happy-dom 20.8.9 прошёл web
277/277 и typecheck. Desktop/mobile browser smoke повторён после остальных
dependency patches. CI source checks не заменяют production image scan,
private-access acceptance и совместный DB/MinIO restore proof.

Web development default и runbook закрепляют порт 3100. API не открывает
отдельный CORS origin для занятого 3000: browser API идёт через same-origin
proxy. Прямой preflight с origin 3000 не получает allow-origin, а health через
3100 proxy возвращает HTTP 200.

Publication workspace дополнительно проверен реальным Chromium render на
desktop и узком layout: проект загружается без ложной ошибки валидации,
сводные карточки и форма переходят в одну колонку, длинное имя проекта не
растягивает страницу.

### Browser checkpoint 2026-10-02

`scripts/browser-stage3-smoke.cjs` прошёл в headless Edge через bundled
Playwright без установки dependencies. Live UI `/montage-assets`, `/vertical`,
`/publications`, `/sources`, `/library`, `/horizontal` проверен на 1440×900 и
390×900. Проверены 10 доступных Select overlays: absolute/fixed positioning,
непрозрачный фон, отсутствие горизонтального clipping, высота options ≥32 px,
ArrowDown и Escape, закрытие с `aria-expanded=false`; страницы не создают
горизонтальный overflow. Выключенные controls не считаются проверенными.

AI `/cuts` проверен на обоих размерах с mock API: без transcript или consent
кнопка выключена; валидный SRT и явное согласие допускают create с idempotency
header; LOCAL_FIXTURE не выдаётся за quality score; после ответа consent
сбрасывается; до ручного выбора acceptance выключен; выбранный exact suggestion
создаёт один acceptance и переводит к job ID в URL. Все API writes перехвачены,
fixture media/job endpoints возвращают контролируемый 503. Это browser workflow
evidence, не live end-to-end render и не внешний AI quality benchmark.

Воспроизведение при доступных Node, Playwright и Edge:

```sh
NODE_PATH=/absolute/path/to/node_modules node scripts/browser-stage3-smoke.cjs
```

Для runtime в другой ОС задайте `CF_PLAYWRIGHT_MODULE` как абсолютный путь к
Playwright; `CF_BROWSER_CHANNEL` по умолчанию `msedge`. UI должен уже работать
на 3100, script не запускает сервисы и не использует 3000. При изменениях
runtime flags доступность selectors может отличаться; минимальное покрытие
требует enabled project controls и material type filter текущего local setup.
Rollback: удалить только smoke script и этот evidence block; runtime/schema
не изменены.

### Clip rollback and browser checkpoint 2026-10-03

Исправлен read/write admission: GET list/detail возвращают сохранённую историю
даже при `CLIP_GENERATION_ENABLED=0`; POST create/accept остаются закрыты до
любой записи. List содержит эффективный `generationEnabled`, учитывающий flag,
model и доступность queue. UI показывает историю и объяснение rollback, не
предлагает новые AI задачи; отсутствие capability у старого API fail-closed.
Описание «ручные отрезки выше» соответствует расположению формы.

Расширенный `scripts/browser-stage3-smoke.cjs` воспроизведён в Edge:
8 сценариев (enabled/retry/disabled/query-failure × 1440/390 px) плюс 10 Select
overlays. Принудительная потеря ответа create и accept допускает отдельный
ручной retry с теми же exact payload/idempotency key; успешный acceptance один
раз переводит к job ID. При выключенном анализе READY history остаётся видимой,
acceptance выключен; при отказе history API видна контролируемая ошибка.
В обоих случаях ручные границы 1–20 секунд оставляют manual submit доступным.
Все API запросы clip-сценариев перехвачены, поэтому это не live media render,
не настоящая внешняя публикация и не качество provider.

Gate среза: API 259/259, web 277/277; API/web typecheck, lint, build и OpenAPI
generation/drift checks прошли. Первый запуск некорректно передал timeout через
дополнительный `--`; default 5 секунд оказался недостаточен для двух OpenAPI
subprocess tests как на Node 22, так и на Node 24. Только эти тесты получили
явный 20-секундный deadline; обычный `pnpm --filter @content-factory/api test`
прошёл без command-line overrides. Добавлена проверка capability в реальном
экспортированном schema, остальные assertions не ослаблены.

Финальные API tests/typecheck/build/lint и web tests/typecheck/build выполнены
на Node 24.15.0, извлечённом из уже закреплённого worker image в ignored
`tmp/runtime-node24/node`; системный Node не изменён, новых images/dependencies
не загружали. Windows browser runner использует bundled Node 24.19.0.
Real PostgreSQL integration 3/3 проверяет также controller list/detail после
rollback, disabled mutations до persistence и ровно один сохранённый intent.
Random fixture rows удалены штатным exact-ID teardown; migrations не изменены.
После roll-forward локальный API запущен на Node 24.15.0 с прежними default-off
admission flags. HTTP через same-origin 3100 вернул health 200 и history list
200 с `generationEnabled=false`; внешний provider не вызывался.

Rollback поведения: вернуть прежние controller/UI/OpenAPI вместе; миграции и
durable history не изменены. Старый UI против нового API безопасен, новый UI
против старого API блокирует AI writes, сохраняя независимую manual cutting.

Publication repository дополнительно воспроизведён на отдельной базе, созданной
из всех migration SQL: exact idempotent replay/conflict, atomic channel revoke,
session cleanup при operator-confirmed absence, retry reset и запрет ручного
absence-resolution при наличии remote ID. База удалена guarded teardown после
теста; restored runtime database не была test target.

Актуальный publication claim SQL после stale-outcome hardening также выполнен
как read-only no-op против локальной runtime PostgreSQL; запрос завершился
`PUBLICATION_CLAIM_SQL_OK`, заведомо отсутствующий intent не был изменён.

## Fresh migration proof

Все 45 миграций применены с нуля; последний proof выполнен на отдельно созданной
базе `cf_eventsub_rotation_20261002` на PostgreSQL 18.6. После deploy база
содержала 74 public-таблицы и 0 непрвалидированных constraints. Disposable база
удалена guarded exact-name командой; повторная проверка `pg_database` вернула 0. Restored runtime database в этом proof не изменялась.

Возобновление Twitch VOD теперь привязано к durable strong ETag. Gateway получает
`If-Range`, PostgreSQL атомарно fencing-ует ETag и полный размер, а смена
представления удаляет partial scratch и запускает одно полное скачивание с нуля.
Regression test с одинаковыми по длине версиями доказывает, что гибридный файл
не загружается. Additive migration применена к restored runtime при нулевом
числе активных Twitch ingest leases; real PostgreSQL + MinIO acceptance `2/2`.

## Проверка готовности API

API readiness checkpoint 2026-10-03 отдельно прошёл 10 unit и 7 integration
tests на Node 24. Реальные service probes не пишут DB/media/queues; dependency
blackholes отвечают unavailable менее чем за две секунды, recovery даёт ready.
Новый schema/client добавляет только GET readiness 200/503 и generic DTO.
Shutdown во время успешного cleanup возвращает unavailable, concurrent healthy
calls coalesce. Independent review `CLEAN`; live API на plain Node без loader
вернул readiness 200/no-store через 3100, health 200, disabled clip history 200.
После restart/build browser smoke повторён успешно; его API scenarios mocked.

## Не является локально доказанным

Hosted CI `65e7e2b`, run `37120609697`: все non-audit source steps и
PostgreSQL job успешны. Оба обязательных audit steps failed; production
promotion остаётся запрещённым. Readiness не подтверждает ни private edge/TLS,
ни matching DB/MinIO restore, ни provider canary.

Реальные внешние публикации и получение байтов конкретным Twitch media gateway
не проверяются без выбранного gateway deployment и production OAuth secrets.
Это rollout/canary gate, а не причина включать небезопасный scraper или хранить
секреты в БД. Все соответствующие flags по умолчанию выключены.
