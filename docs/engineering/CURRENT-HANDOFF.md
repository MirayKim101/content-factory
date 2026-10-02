# Content Factory — current handoff

Обновлено: 2026-09-29. Продолжение Stage 3; защищённые каталоги и их ресурсы не затрагивались.

## Главный результат

Mac snapshot `33f57c8` (`b13ea84` + 19 реальных незакоммиченных файлов) —
активная продуктовая основа. WSL `6e5097d` сохранён в истории и архиве как
альтернативная реконструкция. Решение: ADR-009. Итоговая интеграция сохраняет
обе Git-линии; основной код нельзя снова заменять WSL Stage 1.

Реклама, баннеры, CTA, intro/outro, ручные обложки, сборка, approval и ZIP export
уже реализованы. Предыдущая оценка «конец Stage 1» относилась к неполной копии
и не отражала recovered Mac project. Точный отчёт: `MAC-WSL-MERGE-REPORT.md`.

## Текущий этап

Актуальный воспроизводимый baseline находится в
`STAGE3-LOCAL-ACCEPTANCE.md`: API `254/254`, contracts `23/23`, worker
`331/331`, web `273/273`, lease-recovery PostgreSQL `9/9`, publication
disposable PostgreSQL `1/1`, Twitch
PostgreSQL + MinIO `2/2`, vertical Docker FFmpeg `1/1`, fresh migrations
`43/43` с 73 таблицами и 0 unvalidated constraints. Порт UI — `3100`, API —
`3001`; порт `3000` не используется. Реальные credentialed Twitch media,
YouTube и TikTok canary остаются rollout gate и не подменяются локальным
утверждением о production-публикации.

Последний hardening закрывает late/exact EventSub replay, revoke во время
активного VOD transfer и конкурентный revoke/finalize, повторную проверку
vertical lineage после долгого render/upload, orphan cleanup после неуспешной
Twitch DB-finalization, abort-aware S3 publication chunks и сохранение TikTok
recovery session после необратимой Direct Post initiation.

Vertical DB-finalization теперь также защищён durable cleanup marker до
upload. Потерянный ACK сверяется по exact job/intent/object/size/SHA:
подтверждённый commit сохраняется, доказанный rollback удаляется bounded
compensating cleanup, а недоступная БД оставляет объект reconciler-у. Shutdown
после подготовки output не расходует retry budget: следующий claim ждёт
завершения durable cleanup и затем безопасно переиспользует attempt ordinal.

Clip-suggestion checkpoint реализован и unit-проверен: запуск из `/cuts` через
локально проверенный SRT/VTT и отдельное external-transfer consent; AI worker
передаёт provider-у shutdown/lease AbortSignal и при штатном shutdown возвращает
intent в очередь без расхода retry budget. Disposable PostgreSQL `9/9`
подтверждает repeated shutdown, heartbeat, concurrent reclaim, stale fencing и
retry exhaustion. Конфигурация compose и `.env.example` остаётся default-off.
Этот срез ещё не принят полностью: нужны browser smoke и затем отдельный
provider quality/cost canary.

- Stage 3 control/data plane реализован default-off: Twitch allowlist,
  EventSub inbox и Helix reconciliation; durable resumable VOD import через
  фиксированный media gateway; provider-neutral clip suggestions; отдельный
  9:16 render/approval; scheduled LOCAL_DRY_RUN, YouTube resumable и TikTok
  Direct Post adapters; reconciliation неизвестного remote outcome и metrics.
- Ручной pre-Twitch upload/link, горизонтальный pipeline и ZIP export не зависят
  от Stage 3 flags. Twitch-import создаёт `NOT_REVIEWED` authorization и не
  обходит ручное подтверждение прав.
- Миграция 43 применена к restored PostgreSQL. Реальный local gateway → Range
  download → SHA-256 → MinIO multipart → atomic Project/Source/Artifact smoke
  прошёл; source остался `NOT_REVIEWED`. Production Docker FFmpeg сформировал и
  декодировал 1080×1920 H.264/AAC. Внешний Twitch/YouTube/TikTok credentialed
  smoke намеренно не выполнялся без production credentials и rollout flags.
- Единственный bounded Twitch ingest slot распределяется между каналами по
  durable `lastIngestClaimedAt`; claim и обновление fairness-marker атомарны.
  Реальная PostgreSQL-проверка подтверждает отсутствие starvation между
  постоянно активными каналами.
- Publication worker fail-closed при ошибке heartbeat: потеря связи с БД теперь
  немедленно отменяет активный provider request, не оставляя окно для
  параллельной повторной публикации после recovery.
- Тот же fail-closed fence применяется к status reconciliation: при ошибке
  продления lease provider polling прерывается, а запись оставляется новому
  владельцу после истечения durable lease.
- Twitch VOD download, hash и multipart upload теперь имеют независимый
  heartbeat. Ошибка БД или потеря lease отменяет HTTP/storage signal и не
  переводит чужую попытку в retry/failure; это закрывает зависание на медленном
  gateway между 8 MiB progress checkpoints.
- Worker data plane имеет собственный `TWITCH_VOD_AUTO_INGEST_ENABLED` gate и
  compose передаёт его явно. Одного включённого gateway больше недостаточно:
  auto-ingest запускается только при обоих флагах и валидной конфигурации.
- Все Twitch ingest mutations теперь требуют не только matching owner, но и
  неистёкший lease. Expired worker не может воскресить попытку checkpoint-ом,
  начать upload или записать failure; fence проверен на реальной PostgreSQL.
- Vertical heartbeat, completion и failure также требуют неистёкший lease.
  Поздний FFmpeg-процесс с прежним token больше не может воскресить либо
  финализировать просроченную попытку.
- Publication worker теперь independently fail-closed по
  `PUBLISHING_ENABLED`; compose передаёт флаг явно. Отключение admission больше
  не оставляет фоновой процесс, способный выполнить ранее scheduled intent.
- Fresh-schema proof: все 42 миграции применены в отдельной
  `cf_stage3_fresh_acceptance_20260928` (PostgreSQL 18.6), получено 73 public
  tables и 0 unvalidated constraints. База guarded-удалена и её отсутствие
  подтверждено; restored DB не изменялась.
- Terminal Twitch import больше не является тупиком: оператор может после
  исправления gateway перевести `FAILED_FINAL` обратно в `QUEUED`. Transition
  fenced по candidate state/lease, сохраняет Range-resume progress и сбрасывает
  bounded attempt budget; UI показывает отдельное действие «Повторить импорт».

- Stage 1 и ручной Stage 2 реализованы; историческое Mac evidence сохранено.
- Stage 2B-1 принят: backend и восстановленный UI прошли независимую проверку,
  полный браузерный сценарий и проверку ручного fallback. Evidence:
  `CREATOR-CONTEXT-UI-REVIEW.md`, `CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md`.
- Stage 2B-2 реализован и прошёл независимые проверки кода и restored-runtime
  live acceptance. Это принятый
  технический срез кадров; production admission остаётся feature-flagged.
  Контракт: `tasks/stage2b-sparse-frame-evidence.md`; independent approval:
  `SPARSE-FRAME-CONTRACT-REVIEW.md`.
- `AI_CONTEXT_ENABLED=1` включён в restored API и dev UI. Это только профили,
  private reference, контекст и prompt; внешних AI calls и генерации нет.
- Stage 2B-3 transcript foundation теперь имеет REST/OpenAPI, private
  content delivery с GET/HEAD/Range, отдельный `ai-transcript-v1` worker и
  restored-runtime smoke. Worker fenced по lease/deadline и повторно проверяет
  текущие source authorization, cut lineage, context/profile/prompt revisions
  перед READY. Media worker больше не потребляет AI-очередь. Дополнительный
  disposable PostgreSQL + private object-storage recovery smoke воспроизвёл
  READY, duplicate delivery, expired-lease restart и controlled retry
  exhaustion, а также удаление attempt-owned объекта при stale context;
  ambiguous PUT/COMMIT закрыты durable cleanup tombstone и периодическим
  reconciler; evidence: `TRANSCRIPT-WORKER-RECOVERY-ACCEPTANCE.md`.
- Stage 2B-4a теперь имеет durable PostgreSQL cited-research intent/citations/
  attempts/suggestion/cost, отдельную AI-worker очередь, reloadable operator UI
  и exact metadata apply. Сервер выводит `AI_ASSISTED` или `MIXED`, сохраняет
  thumbnail/provenance и отклоняет stale lineage. Admission остаётся выключен
  `RESEARCH_TEXT_ENABLED=0`; внешние providers не подключены. Disposable-DB
  smoke и независимый review реального diff — PASS/CLEAN; runtime rights policy
  повторно проверяется worker при claim и finalize.

- Stage 2B-5a принят: private deterministic no-likeness PNG candidates,
  restart-safe worker/cleanup, bounded content, exact apply, asset reuse и
  immutable thumbnail provenance прошли disposable PostgreSQL + ContentFactory
  MinIO smoke и независимый CLEAN review. Admission остаётся выключен по
  умолчанию.
- Stage 2B-6 integrated review/economics технически принят после независимого
  `CLEAN` review:
  additive exact snapshots, review/approval/export v2, v1 worker compatibility,
  deterministic five-entry manifest v2, generated client и integrated UI.
  Feature flag `EDITORIAL_INTEGRATED_REVIEW_ENABLED=0` по умолчанию; legacy
  manual revisions без explicit provenance продолжают только v1 путь. Exact
  component lineage/bytes, composite revision/provenance FKs, snapshot and
  economics fingerprint recomputation are enforced; historical AI/MIXED v1 is
  read-only and cannot enter a new export. Focused unit/UI/OpenAPI/ZIP checks,
  API isolated PostgreSQL `24/24`, worker PostgreSQL + real MinIO `29/29`,
  transcript isolated `4/4`, environment `9/9` и migration/schema parity
  проходят на Node 24.15. Approval read, export admission, worker claim и
  finalize повторно проверяют полную authoritative
  research/transcript/image/candidate lineage. До полного продуктового
  acceptance остаётся настоящий human operator benchmark одинакового
  manual/assisted сценария; scripted proxy не является заявлением об экономии.
  Authority/evidence:
  `tasks/stage2b-integrated-review-economics.md`.
  Re-review hardening additionally preserves the exact historical v1
  idempotency hash, snapshots only the declared citation subset in declared
  order without private excerpts, and canonicalizes manifest v2 bytes. Real
  repository manual/MIXED/AI_ASSISTED create/replay gates pass on disposable
  PostgreSQL; the documented timing comparison is explicitly a scripted proxy,
  not an efficiency claim.

## Проверено и не проверено

Frozen install, Prisma validate/generate, typecheck/build и OpenAPI drift
проверены; lint и format также прошли. Финальная Docker-сборка worker успешна.
Независимый review merge adaptations и recovery-защит: CLEAN в ограниченном
объёме, см. `MAC-WSL-MERGE-REVIEW.md`.

Владелец явно разрешил пропустить тестовый этап: полный unit/integration/browser/
render/export/recovery suite этой объединённой версии не выполнялся. Это waiver
текущего merge, не утверждение CLEAN для будущих продуктовых slices.

## Runtime и данные

Изолированная восстановленная среда прошла независимую проверку. Текущий UI:
`http://127.0.0.1:3100`, API: `127.0.0.1:3001`. Порт 3000 зарезервирован
владельцем для другого проекта и не используется Content Factory.
Новые контейнеры, сеть и тома имеют префикс `content-factory-restored`.
Порты зависимостей: 15432/16379/19000/19001. В рабочей базе применена 41
миграций, включая transcript recovery и additive repair semantics для
`updatedAt`; Prisma status сообщает schema up to date. Перед rollout сделан и
полноценно восстановлен в disposable DB свежий backup; evidence:
`STAGE2B6-LOCAL-ROLLOUT.md`. Рабочий `.env` ignored, mode 0600.
Инструкция запуска и остановки: `docs/infrastructure/restored-runtime.md`.

Legacy PostgreSQL/Redis/MinIO и volumes сохранены. Старые API/web/WSL worker
остановлены. Старый env остаётся в `tmp/recovery/wsl-reconstruction.env`;
verified dump — `tmp/recovery/before-mac-baseline-switch-20260909T144250Z.dump`.
Никаких Mac migrations к старой базе не применять, migration checksums не менять.

API unit 128, worker unit 84, Creator Context API integration 2 и worker lease
integration 5 прошли. Интеграционные тесты выполнялись в отдельной одноразовой
`cf_acceptance_20260916`, не в рабочей restored базе. Независимый worker/runtime
review CLEAN. См. `RESTORED-WORKER-VERIFICATION.md`.

Manual assembly/approval/export flags включены только в новой local среде.
Ручной Stage 2 smoke дал видео с рекламой/баннером/CTA, обложку и ZIP с exact
revision. Его evidence: `RESTORED-MANUAL-PIPELINE-SMOKE.md`.
Creator Context UI принят независимо: 192 frontend tests, typecheck/lint/build,
OpenAPI drift и отдельные повторные проверки изменённых случаев. Полный live
сценарий create → private reload → upload → clear → default → context/prompt →
stale → explicit rebind → revoke → MANUAL ZIP прошёл без JS errors. ZIP сохранил
точную контрольную сумму. Dialog проверен обычными кликами при 1440×900 и
1280×720. MinIO allow/deny и ambiguous/terminal upload retry приняты отдельно;
backend/policy commit `b55bd5c` уже в origin/main. Старый failed reference очищен
startup reconciler без прямой правки DB. Данные synthetic fixtures сохранены.

Реальный SIGKILL/lease-expiry worker smoke также независимо воспроизведён:
вторая попытка завершилась READY, ровно один authoritative artifact, совпавшие
checksum и длительность. Evidence: `RESTORED-WORKER-RESTART-SMOKE.md`.

Временный `ContentFactory-merge` удалён 2026-09-16 штатной командой
`git worktree remove` после проверки чистого дерева и совпадения HEAD с main
(`aae651c`). Уникальных исходников или локальных данных в нём не было, только
зависимости и результаты сборки. Единственная рабочая папка — `ContentFactory`;
ветки import/integration/recovery и обе истории сохранены.

## Постоянные ограничения

Seanova, Seanova-new и DockerServer в любом регистре, содержимое и связанные ресурсы полностью
исключены из работы. Полный доступ этого не отменяет. Исходная Mac-папка не
изменяется, её env/кэши/медиа не копируются в Git. Пользовательские `.idea/` и
root `package-lock.json` сохранены вне Git.

С 2026-09-16 владелец поручил продолжать автономно до остатка **30% недельного
лимита** (70% использовано). Владелец затем попросил остановиться раньше для перехода к другому проекту.
Последний замер 2026-09-22 13:43 UTC: 13% использовано, 87% осталось.
Периодически проверять актуальную квоту; перед остановкой сохранить commit,
проверки, состояние сервисов и следующие действия. Старый waiver тестов касался
только merge; новые срезы проходят применимые проверки.

Полный доступ filesystem/network и Docker подтверждён 2026-09-16; это не
отменяет запрет внешних каталогов и их ресурсов. Текущий checkpoint: реализация Stage 2B-2 sparse-frame evidence по ADR-008
с закрытым admission; сквозная приёмка отложена до следующего запуска.

## Stage 2B-2 в работе

Один implementation owner меняет API/schema/worker; после независимого OpenAPI
freeze root реализовал UI в непересекающихся файлах. DevOps отдельно владеет
узкой MinIO frame policy и её regression test.
Runtime migration и узкая frame policy применены только к restored среде.
`EDITORIAL_FRAMES_ENABLED=0`; frame jobs не запускались. Независимые проверки
extractor, API, persistence, worker, UI и configuration завершены CLEAN в своих объёмах. Deadline frame job
по умолчанию 300 секунд; истечение lease само по себе не освобождает slot.

Работа ведётся в ветке `feat/stage2b2-frame-evidence` в той же единственной
рабочей папке. `main` и `origin/main` сохраняют принятый checkpoint `53d13a6`.
Extractor прошёл независимый ограниченный review: 12 focused tests, worker
typecheck, 12 декодируемых JPEG на четырёх media fixtures и контролируемый
отказ для искажаемого tiny-anamorphic input. Evidence:
`SPARSE-FRAME-EXTRACTOR-REVIEW.md`. REST/OpenAPI contract также принят отдельно:
`SPARSE-FRAME-API-CONTRACT-REVIEW.md`. UI реализован, typecheck/lint/build и
211 frontend tests прошли; preliminary mocked-browser viewport check также
прошёл. После двух исправлений независимый frontend review CLEAN, 45 focused
tests/typecheck/lint повторены: `SPARSE-FRAME-UI-REVIEW.md`.
Persistence checkpoint также принят независимо, финальные 11 PostgreSQL integration tests
повторены: `SPARSE-FRAME-PERSISTENCE-REVIEW.md`. Worker orchestration и чистая установка всех 16 миграций проверены;
см. `SPARSE-FRAME-WORKER-REVIEW.md` и `SPARSE-FRAME-MIGRATION-PROOF.md`.
API suite: 138 PASS, worker suite: 114 PASS; full web suite: 211 PASS до
финальных UI fixes, после них независимые 45 focused tests/typecheck/lint PASS.
Live frame acceptance выполнен на подготовленном 28-секундном cut: один
idempotent POST/replay, READY с тремя JPEG, GET/HEAD/Range 206/416, checksum,
private headers и manual ZIP checksum до/после. Evidence:
`tmp/restored-runtime/frames-acceptance/state/evidence.json` (ignored, mode
0600). Stage 2B-2 принят в bounded local scope; Redis-loss and deadline
recovery remain separate follow-up checks.
PostgreSQL integration checks использовали disposable DB.

При восстановлении исчезнувшего worker достижение неизменяемого
`workDeadlineAt` также означает terminal `FRAME_WORK_DEADLINE_EXCEEDED` после
безопасного освобождения slot. Новая доставка не выдаёт истёкшей работе свежий
deadline. Подтверждённая fenced остановка до deadline допускает обычную
ограниченную retry policy. Следующий явный запрос оператора использует новый key.

Подготовлен отдельный synthetic no-reference context для 28-секундного cut
`90a42b66-f834-440e-a411-3b1b7b119eb2`; точные IDs и checksums находятся в
ignored `tmp/restored-runtime/frames-prep/evidence.json`. Старый ручной smoke fixture сохранён. Свежий backup перед rollout:
`tmp/recovery/content-factory-restored-pre-frame-rollout-20260916T042538Z.dump`,
SHA-256 `ee75746798fb66614c204f8730f6da9d19346dea182f3a707ae1641d3d0724b7`.
Полный restore проверен в disposable DB, затем она удалена. Файл ignored, 0600.

Перед будущей миграцией сделан backup
`tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump`,
проверенный двумя полноценными restore в disposable DB. Подробности:
`SPARSE-FRAME-ROLLOUT-PREP.md`. Обе temporary restore DB удалены после проверки;
рабочая база не была restore target. Утверждённая предыдущая версия UI сохранена
в origin/main (`d266ff8`).

## Следующий запуск и расстояние до MVP

1. Сохранить все AI/integrated admission flags выключенными до отдельного
   rollout-решения; ручной Stage 2 путь остаётся рабочим.
2. Владелец выполняет одинаковый bounded manual и assisted сценарий через UI и
   фиксирует реальное foreground attention, wall clock, direct cost, mode и
   acceptance. Точный пошаговый лист: `STAGE2B6-OPERATOR-ACCEPTANCE.md`. Это
   последний незакрытый pre-Twitch product-acceptance gate.
3. Провести браузерный smoke текущего UI на порту 3100. Автоматизированный
   Windows computer-use из этой WSL-сессии не подключился, поэтому HTTP health
   и web `238/238` не заменяют визуальную операторскую проверку.
4. Перед production rollout подключить утверждённые Twitch media gateway и
   OAuth credentials YouTube/TikTok, включать admission flags по одному и
   выполнить credentialed canary. До этого внешние записи закрыты, local
   dry-run и весь ручной путь доступны.

Ручная реклама, ручные обложки и полный локальный horizontal pipeline уже
существуют. Техническая реализация pre-Twitch Stage 2B завершена; полный
продуктовый acceptance ожидает только действия из пунктов 2–3.

22 сентября остановленные ресурсы старого Compose-проекта `content-factory`
удалены точными именами: пять контейнеров, четыре тома, сеть и три старых
worker/runtime образа. Сохранены только `content-factory-restored` контейнеры,
сеть и три restored тома; `content-factory-minio` оставлен как общий образ
текущего runtime.

## Runtime checkpoint при остановке владельцем

Код и acceptance evidence сохранены коммитами `b0b00f1`, `94c1573`, `c4e7f4f`
и `47e50d3` в `feat/stage2b2-frame-evidence`.
API успешно восстановлен после исправления contracts native import; independent
review CLEAN. API session `26457`, PID `95151`, port 3001; root отдельно
подтвердил health `{"status":"ok"}`. AI context и frame admission включены
только в restored local runtime для acceptance. Profile/current prompt GET также
проверены DevOps.
Историческая web session использовала port 3000; этот checkpoint больше не
является текущим. Актуальный UI работает на 3100, а порт 3000 не трогать.
Worker healthy: container
`7d71b253002ca48ab9be822e4e72d964065c784128eea144473e3f93405e900a`.
Worker rebuilt from current frame code; API запускается native Node24. Новых
frame extraction jobs после принятого acceptance не создавали.

Исторические push после `b0b00f1` несколько раз завершались сетевым timeout.
Это ограничение снято: ветка `feat/stage2b2-frame-evidence` синхронизирована с
origin, актуальный подтверждённый SHA указан в последнем checkpoint ниже.

Финальная проверка DevOps: manual export
`f504af29-bc47-4a1d-ae74-821be80f939e` повторно скачан (246691 bytes), SHA
`14cb7a16d87687f917545e4eb99af6f1d62218590ab080b9d27a0b4c5f25e34a`
совпадает с принятым Stage 2. Exact frame POST вернул контролируемый
`503 EDITORIAL_FRAMES_DISABLED`, intent не создан. Evidence:
`tmp/restored-runtime/frames-acceptance/state/evidence.json` (ignored, mode
0600). Перед следующим recovery check сохранить current manual ZIP checksum;
все агенты закончили текущие задачи.

## Stage 3 publication recovery checkpoint (28 сентября)

Оператор теперь может повторно поставить публикацию в очередь после
`FAILED_FINAL` через `POST /api/v1/publications/:id/retry` или кнопку
«Повторить». Retry fail-closed: он доступен только без remote publication ID,
готового результата и незавершённой provider session; `UNKNOWN_REMOTE_STATE`
по-прежнему требует сверки с площадкой и никогда не переотправляется. Повтор
снова проверяет общий и provider-specific feature flags, сбрасывает только
bounded attempt budget и использует существующий intent, не создавая второй.
BullMQ delivery ID включает durable `updatedAt` revision intent: новый retry не
блокируется сохранённой completed/failed job предыдущего запуска, а повторная
доставка той же ревизии остаётся идемпотентной.

Unsafe retry имеет отдельный API-код `PUBLICATION_RETRY_UNSAFE`; UI объясняет
необходимость сверки и показывает Remote ID вместо вводящего в заблуждение
общего конфликта.
Планировщик UI блокирует прошедшее/невалидное локальное время до запроса,
передаёт серверу ISO instant и явно показывает применяемый IANA timezone;
серверная schedule policy остаётся финальной проверкой.
Повтор внешней публикации требует отдельного подтверждения оператора; retry
очищает старый remote status и reconciliation/metrics lease-маркеры, но только
после fail-closed проверки отсутствия remote ID, результата и provider session.

API теперь публикует эффективные runtime-возможности через
`GET /api/v1/publishing/capabilities`: общий admission flag имеет приоритет над
provider-specific flags, секреты и конфигурация наружу не выдаются. UI
фильтрует каналы по этим возможностям, при выключенной публикации остаётся в
режиме просмотра и fail-closed сохраняет историю даже при недоступном
capability endpoint.

После изменения прошли API `232/232`, web `248/248`, typecheck, lint, production
build и двусторонняя проверка OpenAPI drift. Локально API работает на 3001, UI
на 3100; порт 3000 не использовался.

После capability change выбранный канал также проверяется против effective
provider flags: сохранённый, но выключенный внешний канал больше не блокирует
автоматический выбор доступного dry-run/другого канала. Общая admission policy
централизована и используется create channel, create intent, retry, TikTok
creator-info и capability response, поэтому read/write трактуют rollout flags
одинаково. Коммиты `789be77`, `75a3936`, `ca56bde` запушены; локальный HEAD и
origin подтверждены как `ca56bde6b0bd09308a70a814465410c1f6402e6a`.

Publication worker больше не может бесконечно удерживать lease при зависшем
provider request: upload attempt ограничен 30 минутами, reconciliation request
— 60 секундами. Deadline использует тот же abort signal, что и lease fencing;
при lease loss старый worker ничего не освобождает и не финализирует, а при
обычном timeout resumable upload возвращается в bounded retry, reconciliation
claim освобождается. После изменения прошли worker `241/241`, typecheck, lint и
production build.

YouTube и TikTok adapters теперь обёрнуты отдельными provider pools с
concurrency 1. Ожидающий permit request удаляется из очереди при abort, поэтому
lease-loss/deadline не оставляет скрытый вызов, который позднее выполнит внешний
POST. Optional reconciliation/metrics capabilities сохраняются только если их
реально предоставляет adapter. После изменения прошли worker `245/245`,
typecheck, lint и production build.

Provider boundary также содержит in-memory circuit breaker: три
последовательные transient/network/5xx/timeout ошибки открывают circuit на 60
секунд, после чего разрешается пробный вызов. Успех закрывает circuit.
Детерминированные validation failures и штатный TikTok
`UNKNOWN_REMOTE_STATE` не считаются downtime и не блокируют следующие каналы.
После изменения прошли worker `249/249`, typecheck, lint и production build.

Publication retries теперь используют durable `nextAttemptAt`, не перегружая
provider и не сжигая retry budget каждые 30 секунд: backoff 30/60/120 секунд с
cap 15 минут. `scheduledAt` остаётся исходным операторским временем; manual
retry очищает backoff. Additive migration
`20260929080000_publication_retry_backoff` применена к restored DB и с нуля к
одноразовой `cf_stage3_retry_acceptance_20260929`: 43/43 migrations, 73 public
tables, 0 invalid constraints, колонка `nextAttemptAt` присутствует. База proof
удалена, `pg_database` вернул 0. После изменения прошли API `232/232`, worker
`254/254`, typecheck, lint и production builds.

`nextAttemptAt` добавлен в publication response/OpenAPI и показывается в UI
для `QUEUED` retry, поэтому оператор отличает ожидающий backoff от зависшей
задачи. API `232/232`, web `248/248`, оба typecheck/lint/build и двусторонний
OpenAPI drift check прошли.

Publication history UI больше не обрезает историю без объяснения после первых
100 записей: API client принимает bounded cursor/limit, очередь показывает
«Показать более ранние», дедуплицирует границы страниц, а 15-секундный refresh
обновляет свежую страницу без удаления уже загруженных старых записей. После
изменения web `249/249`, typecheck, lint и production build прошли.

Vertical worker теперь ограничивает весь attempt (source download, FFmpeg и
result upload) двумя часами. Deadline использует общий abort signal вместе с
lease fencing, поэтому зависший внешний процесс или I/O не сможет бесконечно
продлевать lease. Добавлен тест renderer, который завершается только по abort;
worker `255/255`, typecheck, lint и production build прошли.

Deadline vertical attempt теперь также передаётся в post-encode `ffprobe` и
чтение версии FFmpeg, поэтому покрывает adapter целиком. Twitch VOD ingest
получил 24-часовой attempt deadline поверх resumable scratch: зависший gateway,
stream или multipart upload больше не может бесконечно продлевать lease;
timeout сохраняет partial file и идёт в bounded retry. Worker `256/256`,
typecheck, lint и production build прошли.

Media и montage API startup reconcilers переведены с boolean guard на
тестируемый single-flight lifecycle. Повторные timer ticks дедуплицируются,
`onModuleDestroy` очищает timer и ждёт текущую операцию до закрытия Prisma/S3.
Wiring drain доказан отдельным delayed reconciliation test; API `240/240`,
typecheck, lint, production build и runtime health 3001/3100 прошли.

Ручной pre-Twitch upload path также защищён при rollout:
`PendingUploadReconciliationStartup` хранит активный AbortController,
отменяет S3 reconciliation в `onModuleDestroy`, ждёт завершение и не логирует
ожидаемый shutdown как timeout/error. API `241/241`, typecheck, lint и build
прошли.

Editorial thumbnail startup reconciliation больше не оставляет S3 I/O жить
после startup timeout или SIGTERM. AbortSignal проходит через editorial storage
port до object storage HEAD/DELETE; cancellation повторно проверяется до
durable finalize/failure и не создаёт ложных cleanup записей. Startup shutdown
также дренирует promise. API `243/243`, typecheck, lint и build прошли.

Добавлен operator revoke publication channel через project-scoped API и UI.
Serializable-транзакция переводит канал в `REVOKED` и отменяет только ещё не
начатые `SCHEDULED`/`QUEUED` intents; `PROCESSING` остаётся в штатном remote
outcome/reconciliation контуре. Повторное создание того же exact channel
является явной реактивацией, отменённые intents при этом не оживают. API
`233/233`, web `250/250`; OpenAPI regenerated.

Исправлен важный unknown-outcome инвариант ADR-010: общий deadline внешнего
YouTube/TikTok attempt больше не переводит intent в автоматический retry.
Timeout теперь фиксирует `UNKNOWN_REMOTE_STATE` даже без remote ID и блокирует
повторный POST до provider/operator reconciliation. Обычные доказанно
pre-commit transient failures продолжают использовать bounded backoff. Worker
`256/256`, typecheck, lint и production build прошли.

Publication abort signal теперь проходит через весь внешний adapter boundary:
S3 identity HEAD, Google/TikTok OAuth refresh, YouTube channel identity verify,
init/chunk/status/metrics transport. Раньше OAuth и pre-upload identity могли
игнорировать 30-минутный attempt deadline. Signal propagation закреплена
тестами resolver-ов; worker `256/256`, typecheck и lint прошли.

Управление publication channels вынесено из admission-зависимой формы в
отдельный блок. Оператор видит активные и отозванные каналы и может применить
kill switch даже когда `PUBLISHING_ENABLED=0`; подключение и создание новых
intent при этом остаются скрыты/запрещены. Web typecheck, lint и production
build прошли.

TikTok Direct Post initiation защищён от дублирующего POST при потерянном
ответе площадки. Network/5xx/invalid-success response после отправки init и
ошибка durable-сохранения полученного `publish_id` теперь переходят в
`UNKNOWN_REMOTE_STATE`; HTTP 4xx остаётся доказанно pre-commit retry. Worker
`259/259`; операторский recovery для случая без remote ID уже доступен в UI.

Закрыт отсутствовавший в Stage 3A evidence gate: новый guarded integration test
поднимает disposable PostgreSQL из всех migrations и проверяет реальный
publication repository — replay/conflict, revoke/cancel, encrypted-session
cleanup, operator resolution, retry и remote-ID fence. Проверка `1/1` прошла,
одноразовая база удалена, restored DB не менялась.

Добавлен bounded operator resolution для timeout без remote ID:
`POST /api/v1/publications/:id/confirm-remote-absent` принимает только явное
`remoteAbsenceConfirmed: true`. Serializable update разрешён исключительно из
`UNKNOWN_REMOTE_STATE` без результата/remote ID, удаляет encrypted resumable
session и переводит intent в `FAILED_FINAL`; UI требует отдельное подтверждение,
после чего доступен уже существующий подтверждаемый retry. API `234/234`, web
`251/251`; OpenAPI regenerated.

Stage 3 project selectors больше не запрашивают запрещённый API limit `100`:
общий cursor paginator читает contract-sized страницы по 50 записей и
используется в Twitch, vertical и publication workspaces. Это устранило ложную
ошибку загрузки publication UI и вернуло проекты за первой страницей. Тот же
фикс применён к montage workspace. Длинные названия проекта и summary cards
получили mobile min-width/ellipsis guards. Реальный Chromium render на 3100
проверен в desktop и узком layout; web `252/252`, typecheck, lint и production
build прошли. Порт 3000 не использовался.

Vertical workspace больше не предлагает заведомо отклоняемое создание задачи
при `VERTICAL_RENDER_ENABLED=0`. Новый read-only endpoint
`GET /api/v1/vertical-renders/capabilities` возвращает только эффективный
`renderEnabled`; UI блокирует admission с объяснением, сохраняя просмотр
истории и approval готовых результатов. OpenAPI JSON/types синхронизированы;
API `235/235`, web `253/253`, typecheck, lint, builds и двусторонние contract
checks прошли.

Локальный web default окончательно переведён с занятого порта 3000 на 3100;
runbook-и синхронизированы. Nest API больше не публикует отдельный hardcoded
CORS origin для `localhost:3000`: UI использует относительный `/api/v1` через
same-origin Nuxt/edge proxy. Runtime proof после rebuild: прямой CORS preflight
с origin 3000 не получает `Access-Control-Allow-Origin`, а
`http://127.0.0.1:3100/api/v1/health` через proxy возвращает 200.

В `.env.example` добавлены отсутствовавшие master switches
`PUBLISHING_ENABLED=0` и `VERTICAL_RENDER_ENABLED=0`. Compose config с явно
включёнными profiles `publishing`, `twitch`, `vertical` проверен: publishing,
Twitch ingestion/auto-ingest/media-gateway и vertical admission остаются `0`.

Устранён vertical recovery dead end: `FAILED_FINAL` render больше не скрывает
исходную READY-нарезку из composer. Новая попытка получает новый idempotency
key и audit row; активный/готовый render всё ещё блокирует дубликат. Поведение
вынесено в тестируемую availability policy; web `255/255`, typecheck, lint и
production build прошли.

Все worker-роли теперь публикуют проверяемую readiness, а не только основной
media worker. AI, publication, Twitch и vertical создают `worker-ready` лишь
после успешной начальной инициализации и удаляют его до shutdown drain; stale
marker очищается до старта. Compose подключает общий healthcheck ко всем пяти
services. Worker `270/270`, typecheck, lint, build и effective compose validation
прошли.

Production API bootstrap теперь явно включает Nest shutdown hooks только для
`SIGINT`/`SIGTERM`. Существующие `onModuleDestroy`/`onApplicationShutdown`
callbacks Prisma, BullMQ dispatchers, S3 и reconciliation timers теперь реально
вызываются при rollout. Контракт сигналов закреплён тестом; API `237/237`,
typecheck, lint и production build прошли.

Ужесточена конфигурация Twitch EventSub callback. Раньше проверка HTTPS
пропускала private IP и произвольный path; теперь разрешены только публичный
host, порт 443 и точный `/api/v1/twitch/eventsub`. Localhost, RFC1918/shared/
link-local ranges, IPv6 loopback/ULA/mapped addresses и чужой path закрыты
fail-closed до обращения к Twitch. Невалидная URL также нормализуется в
контролируемую config-ошибку. Worker `266/266`, typecheck, lint и build
прошли.

Vertical и Twitch workspaces теперь тихо обновляют активные фоновые задачи раз
в пять секунд. Polling не показывает общий loading state, не запускает
параллельные запросы, приостанавливается в скрытой вкладке и прекращается после
terminal state. Ручное обновление по-прежнему показывает ошибки. Web `262/262`,
typecheck, lint и production build прошли.

Publication workspace больше не опрашивает API каждые 15 секунд после того,
как все intent перешли в terminal/operator states. Автообновление сохраняется
для `SCHEDULED`, `QUEUED` и `PROCESSING`, а локальные часы формы продолжают
обновляться независимо. Web `266/266`, typecheck, lint и production build
прошли.

Закрыты известные production dependency advisories: root pnpm overrides
фиксируют `multer 2.3.0` (multipart DoS fixes), `deepmerge-ts 8.0.0` и
`mysql2 3.23.1`. Повторный `pnpm audit --prod --audit-level moderate` вернул
`No known vulnerabilities found`; Prisma validate/generate, API `235/235`,
worker `266/266`, web `266/266`, typecheck, lint и все production builds прошли.

API HTTP perimeter получил единый `helmet 8.3.0` baseline до глобальных pipes и
Swagger setup. Health, API и документация теперь защищены CSP, HSTS,
`X-Content-Type-Options`, `X-Frame-Options`, referrer policy и COOP. Поведение
закреплено изолированным Nest HTTP test без внешних БД/S3; API `236/236`,
typecheck, lint, production build и повторный dependency audit прошли.

Устранён container-hardening drift у `ai-worker`: тот же worker image теперь
запускается с read-only root filesystem, dropped Linux capabilities,
`no-new-privileges`, PID/CPU limits, 1 GiB noexec tmpfs, graceful stop и local
log rotation. Compose render со всеми Stage 3 profiles прошёл.

Ресурсный container baseline распространён на все Stage 3 роли: publication,
Twitch и vertical workers получили PID limit 256, CPU limit 2, 45-секундный
graceful stop и local log rotation 3 × 10 MiB. Compose render всех profiles
подтвердил итоговые effective values.

Устранён shutdown race в Stage 3 reconciliation loops. Publication, Twitch и
vertical timers теперь используют общий `SingleFlightTask`; повторный tick не
дублирует работу, а SIGTERM ждёт текущий reconciliation перед закрытием
repository/storage. Это не даёт штатному rollout искусственно оборвать активную
операцию закрытым PostgreSQL/S3 client. Worker `268/268`, typecheck, lint и
production build прошли.
