# Content Factory — current handoff

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
