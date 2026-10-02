# Stage 3B — Twitch source control plane

## Цель

Добавить default-off реестр разрешённых Twitch-каналов, durable EventSub inbox и
reconciliation VOD-кандидатов. На этом срезе приложение не скачивает видео и не
создаёт проекты автоматически.

## Инварианты

- `TWITCH_INGESTION_ENABLED=0` запрещает внешние подписки, polling и приём новых
  runnable событий до записи;
- broadcaster определяется только Twitch `broadcaster_user_id`, login является
  отображаемым mutable атрибутом;
- поддерживаются только `stream.online` и `stream.offline` версии `1`;
- `message_id` — opaque idempotency key; повтор с тем же телом является replay,
  с другим hash — конфликтом;
- сообщение старше 10 минут или из будущего отклоняется до записи;
- webhook signature считается по точным raw bytes до JSON parsing; secret
  передаётся только через secret reference/config и не сохраняется;
- HTTP callback подтверждает durable inbox insert быстро, обработка выполняется
  отдельно;
- EventSub — сигнал, но не источник истины: Helix `Get Videos` с `type=archive`
  периодически восстанавливает пропущенные события;
- `stream.offline` запускает reconciliation только после configurable delay;
- VOD metadata не считается media source. Байты и exact artifact lineage входят
  в Stage 3C;
- токены, client secret и подписанные raw headers не попадают в API, job payload
  или логи.
- webhook secret имеет отдельный opaque `TWITCH_EVENTSUB_SECRET_VERSION`;
  версия обязана меняться при каждой ротации секрета. Worker под durable
  PostgreSQL lease удаляет старые subscriptions и фиксирует новую версию только
  после строгого пересоздания полного набора.

## Acceptance criteria

1. Дубликат `message_id` создаёт одну inbox row и не повторяет side effect.
2. Same id + different payload hash возвращает conflict и аудитируется.
3. Событие неизвестного broadcaster, типа или версии отклоняется fail-closed.
4. Replay-window проверяется до persistence.
5. Channel revoke останавливает admission, но сохраняет историю.
6. Reconciliation upsert по provider video id идемпотентен.
7. VOD становится `READY_FOR_INGEST` не раньше `availableForIngestAt`.
8. Cursor обновляется атомарно вместе с принятой страницей reconciliation.
9. Ошибка/таймаут Helix не продвигает cursor.
10. При выключенном флаге ручная загрузка MP4 и Stage 2 остаются без изменений.

## Rollback

Сначала выключить `TWITCH_INGESTION_ENABLED`, затем остановить ingest worker.

## Automatic VOD data plane

Автоматический импорт включается только совместно тремя независимыми флагами:
`TWITCH_INGESTION_ENABLED=1`, `TWITCH_VOD_AUTO_INGEST_ENABLED=1` в API и
`TWITCH_VOD_MEDIA_GATEWAY_ENABLED=1` у Twitch worker. Gateway должен быть
фиксированным HTTPS origin с bearer token; произвольные URL от Twitch или
пользователя worker не принимает.

Импорт хранит durable intent, lease и byte checkpoint. Частичный MP4 лежит в
отдельном persistent scratch volume и продолжается HTTP Range-запросом после
рестарта. Перед multipart upload проверяются размер, MP4 `ftyp` и SHA-256.
Проект, source, artifact и связь с VOD создаются одной транзакцией только после
завершения upload. Идентификаторы и object key детерминированы от intent, поэтому
retry после неизвестного результата не создаёт второй проект или объект.

Автоматически импортированный source остаётся `NOT_REVIEWED`: оператор должен
подтвердить права тем же ручным действием, что и для обычной загрузки. Пока это
не сделано, source probe и последующая обработка не запускаются.

Для экстренного отключения сначала выставить
`TWITCH_VOD_AUTO_INGEST_ENABLED=0`, затем
`TWITCH_VOD_MEDIA_GATEWAY_ENABLED=0`. Уже импортированные проекты и ручной
`link-project` путь сохраняются.

Для плановой ротации остановить все Twitch workers, одновременно задать новый
`TWITCH_EVENTSUB_SECRET` и новую `TWITCH_EVENTSUB_SECRET_VERSION`, затем
перезапустить API и все Twitch workers с одинаковой конфигурацией. Rolling
overlap воркеров с разными версиями секрета запрещён: opaque version не задаёт
порядок версий. PostgreSQL lease сериализует сверку и ротацию одинаково.
Значение версии не является секретом, но должно быть новым безопасным
идентификатором длиной до 64 символов. До durable completion worker повторяет
полную ротацию; HTTP 409 при strict recreate не считается успехом. Старую
версию секрета не удалять из secret manager до появления успешного
`twitch_reconciliation_completed` после ротации.

Первый запуск версии также пересоздаёт существующие managed subscriptions:
их secret не возвращается Twitch API, поэтому старый набор нельзя признать
совместимым по одному callback. Failed/disabled subscriptions сохраняются в
remote list до cleanup и удаляются перед повторным созданием. Обычная сверка
также удерживает lease, поэтому не создаёт подписки посреди ротации.

Local verification 2026-10-02: worker `342/342`, worker lint/typecheck/build,
API typecheck/build; fresh database `cf_eventsub_rotation_20261002` содержит
`45/45` миграций, 74 public tables и 0 unvalidated constraints. Twitch
PostgreSQL + MinIO acceptance `2/2` включает CURRENT/BUSY, expiration reclaim,
stale completion rejection и release fencing. Для этого integration scenario
обязательна отдельная база с префиксом `cf_eventsub_rotation_`: тест singleton
rotation state не допускается на сохранённой runtime базе.

Rollback: остановить Twitch workers, отключить admission, вернуть прежние
secret/config и совместимые API/worker версии. Новую таблицу и применённые
миграции сохранять. При повторном включении использовать новую secret version
и дать worker пересоздать managed subscriptions; вручную менять applied version
нельзя. Live credentialed rotation требует отдельной canary-проверки доставки.
Таблицы channel/inbox/candidate не удалять: они нужны для deduplication и
возобновления reconciliation. Ручной pre-Twitch путь остаётся основным.

## Official references

- <https://dev.twitch.tv/docs/eventsub/>
- <https://dev.twitch.tv/docs/eventsub/handling-webhook-events>
- <https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/>
- <https://dev.twitch.tv/docs/api/videos>
