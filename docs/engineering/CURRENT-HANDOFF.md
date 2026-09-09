# Content Factory — current handoff

## Строгий запрет владельца — 2026-09-09

Каталоги `Seanova` и `DockerServer` в любом регистре, включая `seanova` и
`dockerServer`, полностью исключены из работы во всех расположениях вместе
с содержимым. Запрещены чтение, просмотр, поиск, изменения, выполнение команд
и косвенный доступ через ссылки, mounts или containers; связанные сервисы,
контейнеры, volumes и данные также не трогать. Правило обязательно для всех
субагентов. Полный доступ и автономный режим не отменяют запрет. Точная
формулировка закреплена в `AGENTS.md`.

## Восстановление на Linux — 2026-09-09, в работе

- Рабочая папка: `/home/miray/Projects/ContentFactory`.
- После `git fetch origin` локальный `main` и `origin/main` указывают на
  `1dde0b41da57c6869a9c9414a451b0c9d7990af3`.
- Notion README от 2 сентября описывает нарезку, медиатеку и authorization
  и ссылается на `f93d1b1`. Этот commit отсутствует в доступных refs и Git
  objects; reflog содержит только clone, unreachable objects не найдены.
- Текущий код содержит только загрузку и статус проекта. Восстановление
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
- API был проверен на `127.0.0.1:3001`, затем намеренно остановлен перед
  миграцией authorization; проверка health вернула connection refused.
  Web остаётся на `127.0.0.1:3000`, но загрузка недоступна до запуска нового API.
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
  Один backend implementer выполняет вертикальный срез; review реализации
  пока не проведён. Прогресс загрузки сохранён в commit `0b814b9`.
- Снимок PostgreSQL повторно создан после остановки API:
  `tmp/recovery/before-source-authorization.dump` (0600, custom format,
  `pg_restore --list` успешен; 3 существующих источника). До запуска нового
  совместимого API старый upload не включать. Migration и backfill counts
  проверяются при остановленном API.
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
  перед authorization implementation: 19% использовано. Скрипт в `tmp/`
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
