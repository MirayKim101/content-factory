# ADR-010: Stage 3 ingestion, vertical и publishing boundaries

- Статус: accepted (local/default-off implementation only; external provider rollout and production deployment remain unapproved; Content Factory architect decision 2026-10-03)
- Дата: 2026-09-27
- Область: Stage 3

## Контекст

Stage 2B создаёт подтверждённый immutable пакет для ручной публикации. Stage 3
должен добавить Twitch ingestion, vertical results и публикацию, не превращая
внешние API, Redis или OAuth tokens в источник истины и не обходя exact human
approval.

Twitch EventSub сообщает `stream.online` и `stream.offline`, но потерянные при
разрыве WebSocket события не replay-ятся. VOD появляется только если он включён
у broadcaster. Поэтому EventSub является сигналом, а периодическая Helix
reconciliation — обязательным источником восстановления.

## Решение

Stage 3 поставляется четырьмя bounded slices:

1. **3A Publishing control plane** — каналы назначения, exact publication
   intent, расписание, идемпотентность, default-off admission и local dry-run
   adapter без внешних записей.
2. **3B Twitch source control plane** — разрешённые broadcaster channels,
   EventSub inbox с signature/deduplication, reconciliation cursor и delay после
   offline; без скачивания полного VOD через NestJS.
3. **3C Resumable ingest и vertical pipeline** — multipart data plane, bounded
   ingest pool, provider-neutral `ClipGenerationProvider`, exact source/artifact
   lineage и отдельное human approval для vertical result.
4. **3D External publishing** — YouTube/TikTok adapters, encrypted credential
   references, per-platform pools/circuit breakers, status reconciliation и
   analytics. Реальная запись включается по platform/channel отдельно.

PostgreSQL остаётся authoritative. Queue содержит только идентификаторы.
External provider IDs, attempts, request fingerprints и responses сохраняются
до подтверждения результата. Повторная доставка не создаёт вторую публикацию.

## Инварианты публикации

- intent ссылается на текущий exact approval и READY export/result;
- изменение editorial, render или approval делает новый запуск невозможным;
- `scheduledAt` хранится как UTC instant, UI показывает timezone явно;
- один idempotency key не может принадлежать другому payload;
- `PUBLISHING_ENABLED=0` запрещает создание runnable intent до записи строки;
- local dry-run доказывает state machine, но никогда не называется публикацией;
- credentials не возвращаются API и не хранятся в payload/job/log;
- provider timeout означает `UNKNOWN_REMOTE_STATE` и reconciliation, а не
  немедленный повтор POST;
- cancel разрешён только до remote commit point;
- Twitch source и target publishing channels — разные bounded contexts.

## Twitch transport

Для локальной разработки используется EventSub WebSocket; production webhook
требует public HTTPS:443 endpoint и signature verification. Любой transport
дополняется polling reconciliation, потому что WebSocket reconnect не даёт
replay пропущенного окна.

## Rollback

Сначала выключить admission каждого provider, затем дать claimed attempts
завершиться или перейти в reconciliation. Не удалять durable intents и external
IDs. Возврат к ручному ZIP остаётся доступен независимо от Stage 3.

## Источники

- <https://dev.twitch.tv/docs/eventsub/>
- <https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/>
- <https://dev.twitch.tv/docs/eventsub/handling-websocket-events>
- <https://dev.twitch.tv/docs/api/videos>
- <https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content>
