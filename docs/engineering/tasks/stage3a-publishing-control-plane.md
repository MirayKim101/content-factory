# Stage 3A — publishing control plane

## Цель

Добавить минимальный сквозной и безопасный фундамент планирования публикаций без
реальных provider credentials и внешних записей.

## Scope

- `PublicationChannel`: platform, display name, external channel reference,
  timezone, enabled/revoked state; без secret/token полей;
- `PublicationIntent`: exact approval/export lineage, scheduled UTC instant,
  platform metadata snapshot, idempotency fingerprint и durable state;
- provider port и `LOCAL_DRY_RUN` adapter, который проходит state machine без
  сетевого вызова и явно возвращает `DRY_RUN_READY`;
- create/list/get/cancel API с pagination и fail-closed feature flag;
- отдельный bounded publishing worker/reconciler contract;
- object-storage range reads ограничены 128 MiB: это покрывает максимальный
  финальный TikTok chunk, при этом TikTok adapter выполняется с concurrency 1;
- UI: раздел «Публикации» со списком, датой/часовым поясом, статусом и явным
  предупреждением dry-run;
- OpenAPI, additive migration, unit/component и disposable PostgreSQL tests.

## Не входит

- OAuth flow и хранение credentials;
- реальный YouTube/TikTok POST;
- Twitch ingestion;
- vertical generation;
- analytics polling.

## Acceptance criteria

1. При `PUBLISHING_ENABLED=0` create возвращает controlled 503 и не создаёт row.
2. Intent принимается только для current approval и READY current export.
3. Same key + same payload replay возвращает тот же intent; другой payload — 409.
4. Время в прошлом и невалидная timezone отклоняются до записи.
5. Duplicate delivery создаёт один dry-run result.
6. Cancel после terminal result не меняет состояние.
7. Список paginated и не смешивает project/channel ownership.
8. UI не называет dry-run опубликованным контентом.
9. Manual ZIP download остаётся рабочим при любом состоянии Stage 3.
10. Migration rollback не удаляет publication history; admission-first rollback
    документирован и протестирован.

## Rollback

Сначала установить `PUBLISHING_ENABLED=0` одновременно для API и publication
worker, затем пересоздать/остановить compose profile `publishing`. Worker
проверяет этот флаг при старте и fail-closed не обрабатывает уже scheduled
intent при выключенном admission. Provider-specific флаги выключаются до
удаления credentials. Таблицы `Publication*` и их историю не удалять; ручной
ZIP download не зависит от publishing profile.

## Следующий срез

После независимого review 3A: Stage 3B Twitch channel registry + EventSub inbox
и reconciliation, всё default-off.
