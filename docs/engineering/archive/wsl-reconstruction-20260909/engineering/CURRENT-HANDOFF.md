# Content Factory — current handoff

## Строгий запрет владельца — 2026-09-09

Каталоги `Seanova` и `DockerServer` в любом регистре, включая `seanova` и
`dockerServer`, полностью исключены из работы во всех расположениях вместе
с содержимым. Запрещены чтение, просмотр, поиск, изменения, выполнение команд
и косвенный доступ через ссылки, mounts или containers; связанные сервисы,
контейнеры, volumes и данные также не трогать. Правило обязательно для всех
субагентов. Полный доступ и автономный режим не отменяют запрет. Точная
формулировка закреплена в `AGENTS.md`.

## Контрольная точка перед лимитом — 2026-09-09 14:01 UTC

- Последний замер: 47% недельной квоты. Новые работы и делегирование
  остановлены; оставшийся запас используется только для сохранения Git/Notion.
- Upload и exact-source authorization приняты ранее. Manual cut работает
  через API и браузер, реальные SIGKILL/Redis-down сценарии прошли.
- **Manual cut: NOT ACCEPTED / WIP.** Независимый reviewer не нашёл открытых
  HIGH/MEDIUM дефектов после исправлений, но остаются 8 обязательных сценариев.
  Полный список и доказательства: `RECOVERY-MANUAL-CUT-REVIEW.md`.
  Не начинать Stage 2 и не объявлять MVP готовым до закрытия этой матрицы.
- Последний независимый прогон: manual-cut 9/9, media stream 10/10,
  worker adapters/lifecycle 5/5, PostgreSQL 7/7 на отдельной временной базе;
  база удалена после проверки. Format/lint/typecheck/build/OpenAPI прошли.
  Full API integration 22/22 прошёл до добавления последнего isolated barrier.
- Текущие API PID 770966/session 98837 и web session 60440, ports 3001/3000.
  Worker image `613426ce265362aa076f69df71114de8f266d1358d0c5548c426f8abb1b36369`
  healthy, default lease/heartbeat 120000/30000. Последний browser job
  `dc6abaa6-e3b2-45f2-ad41-1bd67cdb2dd6` прошёл. Сервисы оставлены для локальной
  проверки; при новой сессии проверить фактическое состояние процессов.
- Все агенты завершили работу. Код сохраняется в recovery-ветку как WIP;
  main не меняется. Не трогать пользовательские `.idea/` и root `package-lock.json`.
- Следующий шаг: продолжить **только оставшиеся acceptance tests**, начиная с
  deterministic authorization/claim и concurrent POST, затем оставшиеся строки
  reviewer report. Существующие доказательства повторять только при изменениях.

## Восстановление на Linux — 2026-09-09, в работе

- Рабочая папка: `/home/miray/Projects/ContentFactory`.
- После `git fetch origin` локальный `main` и `origin/main` указывают на
  `1dde0b41da57c6869a9c9414a451b0c9d7990af3`.
- Notion README от 2 сентября описывает нарезку, медиатеку и authorization
  и ссылается на `f93d1b1`. Этот commit отсутствует в доступных refs и Git
  objects; reflog содержит только clone, unreachable objects не найдены.
- На момент clone код содержал только загрузку и статус проекта. Восстановление
  более свежего кода с Mac пока не подтверждено. Не считать возможности из
  Notion реализованными на этом компьютере без проверки исходников.
- Notion: <https://app.notion.com/p/3cff0d44c82d8146a94dd8ff2ada3d08>.
- Docker Desktop `4.89.0`, Engine `29.7.2`, Compose `v5.5.0` доступны из
  WSL2 через context `default`. Node `24.15.0` и pnpm `10.34.5` установлены
  в игнорируемый `tmp/runtime`; frozen-lockfile install прошёл. Инструкция:
  `docs/infrastructure/linux-readiness.md`.
- Создан новый локальный `.env` с правами `0600`; секреты не выводились.
  PostgreSQL, Redis и MinIO — healthy, minio-init завершился с кодом 0.
  Обе существующие миграции успешно применены. Данные с Mac не переносились.
- Текущая рабочая ветка: `recovery/linux-mvp-20260909`.
  В origin сохранены `0b814b9` (upload progress), `e733847` (ADR-003) и
  `6911369` (media runtime). Approved manual-cut contract сохранён локально
  в `e60b4ca`: `docs/engineering/RECOVERY-MANUAL-CUT.md`; его реализация
  начинается только после независимой приёмки authorization.
- API был намеренно остановлен перед миграцией authorization. После успешного
  переноса 3/3 записей запущен только новый совместимый build на
  `127.0.0.1:3001` (session 67766); health успешен.
  Web остаётся на `127.0.0.1:3000`, загрузка снова доступна.
  При восстановлении сессии сначала проверить доступность; не предполагать,
  что процессы сохранились.
- API verification на WSL: 22 unit и 12 integration tests passed, lint и
  typecheck passed; Prisma Client 7.10.0 сгенерирован.
- Восстановлен upload progress; независимый reviewer — CLEAN. Полный web suite
  23/23, lint, typecheck и OpenAPI checks прошли. Browser smoke
  показал реальные bytes/percent/speed/ETA, отдельную server finalization,
  HTTP 201 `SOURCE_READY` и HTTP 415 с понятной ошибкой для повреждённого MP4.
  Evidence и повторяемый сценарий: `tmp/browser-smoke/` (игнорируемые файлы).
  Маленькие тестовые исходники оставлены в новой локальной базе/MinIO.
- Reviewer независимо повторил browser smoke, включая отдельную server
  finalization и corrupted MP4 failure; JavaScript errors отсутствуют.
  Следующий срез — ADR-003 exact-version source authorization: design review
  завершён после исправления 3 замечаний (migration quiescence, отсутствие
  скрытой legacy-аттестации, replay после rotation декларации).
  Реализация принята: независимый reviewer повторил все проверки и browser
  smoke, итог CLEAN. Подробности в `RECOVERY-SOURCE-AUTHORIZATION-REVIEW.md`.
  API 27 unit / 16 integration, web 32 tests; форматирование, lint, typecheck,
  build и OpenAPI checks успешны. Прогресс загрузки сохранён
  в commit `0b814b9`.
- Снимок PostgreSQL повторно создан после остановки API:
  `tmp/recovery/before-source-authorization.dump` (0600, custom format,
  `pg_restore --list` успешен; 3 существующих источника). До запуска нового
  совместимого API старый upload не включать. Непосредственно перед миграцией
  создан свежий проверенный snapshot
  `tmp/recovery/before-source-authorization-20260909T1911.dump` (0600).
  После миграции: sources=3, authorizations=3, legacy_cleared=3,
  audit_preserved=3. Автоматический isolated migration test покрывает backfill
  и полный rollback malformed legacy input; integration suite 16/16 passed.
- Root browser authorization smoke прошёл: upload содержит только `name/file`,
  legacy rights=null, `NOT_REVIEWED`; отдельное подтверждение даёт `CLEARED`,
  повтор неизменяемый `200`, неверный checksum — безопасный `409`, reload
  сохраняет audit, JavaScript errors отсутствуют. Evidence:
  `tmp/browser-smoke/authorization-evidence.json`, скрипт и screenshots рядом.
  Тестовый проект `e6a8313b-273c-4578-832a-afaa03679cb7` использует 6-секундный
  synthetic MP4, пригодный для следующего cut smoke. Один предыдущий маленький
  upload также сохранён после ошибки browser harness (Chromium не возвращает
  multipart через postDataBuffer); это не ошибка приложения.
- Media runtime image `content-factory-media-runtime:node24.15.0-ffmpeg5.1.9`
  собран из pinned Node/Debian и FFmpeg package. Orchestrator независимо
  повторил unprivileged, no-network encode/probe smoke: H.264 128×72,
  duration 1.000000. Worker и фоновые jobs пока не реализованы.
- После независимого authorization smoke в локальной базе 6 источников и 6
  authorization rows; 3 legacy clearance/audit сохранены. Reviewer также
  проверил читаемость fresh dump. Следующий implementation owner реализует
  `RECOVERY-MANUAL-CUT.md` по протоколу `RECOVERY-MANUAL-CUT-VERIFICATION.md`.
- Authorization принят и отправлен в origin: `42daf8a`. Агент `manual_cut`
  начал следующий срез и владеет API/schema/shared package/worker/UI/tests.
  Планируется `packages/manual-cut`, `apps/worker`; точные dist paths ещё
  проверяются первой компиляцией. Infrastructure остаётся отдельной DevOps
  ответственностью после подтверждения entrypoint. Данные BullMQ — только
  `{jobId}`. До успешных smoke/recovery/review не считать нарезку готовой.
- Packaging checkpoint: type-only import API generated source дал TS6059.
  Условно одобренный второй Prisma generator собрал shared package, но API
  injection не прошёл TS2345 из-за разных generated type identities. Cast и
  второй API pool запрещены. Независимый `source_authorization` одобрил
  нейтральный build-only пакет `@content-factory/prisma-client`, компилирующий
  единственный существующий API-owned generated source; prototype compile
  прошёл. Финальный контракт в `RECOVERY-MANUAL-CUT.md` требует общей type
  identity, одного API pool, чистой генерации и сборки по зависимостям.
  CLI отказал в восстановлении
  прежнего архитектора/новом thread (`agent thread limit reached`), поэтому
  переиспользован действующий участник. `worker_runtime` готовит CI/runtime,
  подтвердил `apps/worker/dist/main.js`. Worker image собран; независимый
  offline smoke подтвердил UID 1000, Prisma/shared imports и FFmpeg 5.1.9.
  Worker ещё не запускался. Нарезка находится в реализации и review.
- Локальная cut migration применена 2026-09-09 13:00 UTC после проверенного
  snapshot `tmp/recovery/before-manual-cut-20260909T130003Z.dump`.
  Существующие 6 projects/sources/authorizations/artifacts сохранены, jobs=0.
  Новый API прошёл read-only HEAD/Range smoke (200/206/416); полноценный cut
  smoke и crash/restart verification ещё не выполнены.
- Исправление локальной cut migration завершено: точные original bytes
  восстановлены и независимо сверены, добавлены только BEGIN/COMMIT.
  Guarded checksum-only transaction сохранила все остальные metadata,
  схему и бизнес-данные; migrate status и deploy no-op успешны.
  Промежуточное расхождение было лишним LF в проверочном восстановлении.
  Подробные hashes, backup, guards и rollback evidence:
  `RECOVERY-MANUAL-CUT-MIGRATION-REPAIR.md`.
  API был остановлен на время операции; пауза retained writers снята после
  postchecks. Перед browser smoke проверить новый API и worker отдельно.
- Нормальный API/browser cut smoke прошёл на worker image
  `2c7e2df8656bd63da3ed195891df1820d1b15ebef4a34876b1c4f5247a1c5c09`:
  два разных результата 1500/2500 ms, SHA/size совпадают с artifact,
  replay без дубликата, conflict 409, out-of-bounds — controlled final failure.
  Browser player/seek/create/reload/download без JS errors; скачанный MP4
  1500 ms, H.264/AAC. Отчёт `RECOVERY-MANUAL-CUT-SMOKE.md`.
  Первый run выявил MinIO policy только sources/_; DevOps добавил узкий
  projects/_/cuts/*, проверил allow/deny и reprovision только minio-init.
  Reconciler завершил шесть старых output cleanup; failed jobs сохранены.
- API новый process PID 770966/session 98837; web после dependency install
  перезапущен в session 60440. Worker активен, только Content Factory profile.
  Независимый reviewer завершил crash/Redis-loss окно: SIGKILL после claim
  восстановлен attempt2 с одним artifact; Redis-down POST сохранил QUEUED
  без attempt, после восстановления выполнен один раз. SHA/duration/scratch
  проверены. Все jobs terminal, worker defaults 120000/30000 восстановлены.
  Финальный image `613426ce265362aa076f69df71114de8f266d1358d0c5548c426f8abb1b36369`
  healthy, normal browser smoke повторён успешно. Full integration 22/22 PASS.
  Review пока CONDITIONAL/NOT ACCEPTED: исполнитель добавляет недостающие
  точные acceptance-barrier tests, обязательные пробелы не отменены.
- Исходные untracked файлы владельца: `.idea/` и `package-lock.json`; сохранять.
- Владелец разрешил автономную работу и субагентов, с остановкой на 50% квоты.
  Чтение через `codex app-server --stdio`, JSON-RPC `initialize`, затем
  `account/rateLimits/read` подтверждено: на первой успешной проверке
  `codex.primary.usedPercent=13`, окно 10080 минут (неделя). Проверять между
  рабочими шагами и перед новым делегированием; при 50% остановить новые работы
  и сохранить состояние. Это периодическая проверка, а не жёсткий лимитер.
  Не расходовать reset credits автоматически. Способ через `app-server proxy`
  в этой среде не сработал; standalone stdio завершать после ответа.
  Локальная команда: `node tmp/recovery/read-quota.cjs`; последняя проверка
  2026-09-09 14:01 UTC: 47% использовано. Скрипт в `tmp/`
  не хранится в Git.

## Предыдущий handoff с Mac (исторические результаты)

Обновлено: 2026-09-01
Ветка: `main`
Последний завершённый commit: `56bb2af feat: add stage 1 upload interface`

## Готово

- локальные PostgreSQL, Redis и private MinIO;
- ручная загрузка одного разрешённого MP4 через Nuxt SPA;
- same-origin `/api/v1` routing без Nitro BFF (ADR-001);
- PostgreSQL metadata, MinIO object, SHA-256, lineage и safe DTO;
- idempotency/recovery для lost response, reload, stale response и polling;
- generated OpenAPI contract и live drift check;
- архитектура bounded parallel media pipeline и больших VOD (ADR-002);
- финальный independent review: CLEAN;
- проверка: 22 backend unit, 12 integration и 20 frontend tests;
- маленький H.264 MP4 успешно загружен через browser smoke.
- реальный `video-test.mp4` размером `3 813 099 228` bytes успешно загружен:
  PostgreSQL `SOURCE_READY`, объект MinIO `READY`;
- подтверждено, что текущий исходник хранится в persistent MinIO volume
  бессрочно: пользовательского delete endpoint, retention policy и экрана
  управления проектами пока нет.

## Сейчас запущено локально

На момент записи API и Nuxt были запущены для показа владельцу:

- UI: `http://127.0.0.1:3000/`;
- API: `http://127.0.0.1:3001/api/v1`;
- Docker Compose: PostgreSQL, Redis и MinIO; `minio-init` — ожидаемо завершённый
  one-shot provisioning container.

После перезапуска нельзя предполагать, что процессы сохранились: проверить
порты и Compose перед использованием.

## Следующая пользовательская цель

Stage 1 должен впервые нарезать видео:

```text
загруженный MP4
-> ручные start/end таймкоды
-> PostgreSQL PipelineJob/JobAttempt
-> BullMQ worker
-> FFmpeg/FFprobe в фоне
-> статус и controlled failure
-> скачивание готового горизонтального MP4
```

Ограничение среза: без Twitch, AI, вертикальных клипов, баннеров и публикации.
Использовать bounded concurrency; локальный default — один тяжёлый FFmpeg slot,
но job model не должна предполагать глобальную последовательность.

## Обязательное ближайшее UX-улучшение загрузки

После большого smoke с `video-test.mp4` подтверждено, что интерфейс должен
показывать реальный
клиентский upload progress:

- отправленные и общие bytes;
- процент;
- текущую скорость;
- приблизительное оставшееся время;
- отдельную стадию после 100%: сервер проверяет и сохраняет файл;
- terminal `SOURCE_READY` или понятную ошибку.

Нельзя изображать процент серверной проверки без измеримых данных backend. Для
будущей multi-upload очереди progress и ошибка принадлежат каждому видео; общий
экран показывает active/queued/completed counts. Для browser upload progress
допустим один owned typed XHR transport adapter поверх generated OpenAPI types;
raw transport не размещается в компонентах.

## Доступный большой тестовый файл

`/Users/mirai/Downloads/video-test.mp4` — `3 813 099 228` bytes (около 3.55
GiB), двухчасовой Full HD. Один большой smoke уже выполнен успешно.
Не изменять, не перемещать и не добавлять в Git. Не загружать автоматически без
необходимости: для следующих проверок сначала использовать маленький fixture.
Загруженный объект не удалять без явного указания владельца.

## Принятое архитектурное решение, которое ещё не реализовано

Per-upload checkbox подтверждения прав убрать. Нельзя скрывать его и продолжать
автоматически записывать ложное `rightsConfirmed=true`. Новые источники получают
`authorizationStatus=NOT_REVIEWED`; проверка выполняется один раз на уровне
зарегистрированного источника, а автоматическая публикация разрешается только
для `CLEARED`. Старые записи мигрируются как `CLEARED/LEGACY_ATTESTATION`.
Нужны отдельный ADR, additive migration, обратная совместимость API и полный
contract/UI/test/doc slice.

## Выбранный Stage 1 UX таймкодов

Не строить сейчас полный CapCut/iMovie timeline. Использовать встроенный
видеоплеер, кнопки «Установить начало»/«Установить конец», редактируемые поля
таймкодов и список отрезков. В контракте хранить точные `startMs`/`endMs`, чтобы
позже добавить thumbnails и draggable timeline без изменения worker-модели.

## Первый шаг после восстановления

1. Проверить `git status`, Compose, API/web процессы и свободное место MinIO.
2. Выполнить bounded slice: upload progress плюс approved removal правовой
   checkbox с additive source-authorization migration и independent review.
3. Затем реализовать главный Stage 1 slice: player-based manual timestamps,
   background FFmpeg cut, status и download.
4. После появления списка проектов добавить безопасное удаление проекта и
   артефактов; до этого не удалять MinIO volume вручную.
