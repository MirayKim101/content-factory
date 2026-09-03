# ADR-005: Immutable montage assets and assembly recipes

- Статус: accepted (Solution Architect review, 2026-09-03)
- Область: Stage 2, локальный горизонтальный pipeline

## Контекст

Roadmap требует рекламные вставки, intro/outro и баннеры. Существующий
EditorialAsset/thumbnail контракт ограничен изображениями 10 MiB и обязательными
размерами. Worker сейчас получает SOURCE artifact; новый тип задания нельзя
обрабатывать существующей веткой CUT_SEGMENT по умолчанию.

## Решение

Отдельный immutable MontageAsset внутри editorial-content, без нового сервиса
или очереди. Сначала upload/list/content и background MP4 probe (slice 2a),
затем immutable assembly recipe (2b), затем отдельный render slice.

Добавить MONTAGE_ASSET_PROBE и montageAssetId в durable PipelineJob с type-aware
constraints. Сохранить exact sourceId/sourceVersion как authorization context;
проверяемые байты адресовать только через montageAssetId. Claim и application
handler используют явные discriminated branches; неизвестный тип fail-closed.
Существующий thumbnail контракт и CUT_SEGMENT не ослаблять.

Intent и checksum/size сохраняются до enqueue; PostgreSQL authoritative,
Redis disposable. MP4 probe с timeout выполняется только worker. READY требует
lease-fenced финализации exact asset identity. Новый файл — новый assetId;
авторизованные private reads, отдельные upload fingerprint и cleanup intent.
Неоднозначный DB commit требует reread, а не удаления object.

Рецепты (следующий slice) append-only, с CAS и idempotent replay. Времена
относятся к готовой нарезке: intro → cut[0,t) → ad → cut[t,D) → outro.
Banner/CTA показываются только на cut, прерываются на рекламе. Metadata revisions
независимы; будущий approval фиксирует обе точные revisions. Raw FFmpeg arguments,
remote URL ingestion и автоматическая публикация не входят.

## Альтернативы

- Сохранить только metadata: безопасно, но roadmap не продвигается.
- Расширить thumbnail таблицу/DTO: меньше таблиц, но ослабляет проверенные image
  invariants. Отклонено в пользу отдельного MontageAsset в том же модуле.
- Новый сервис/очередь: не нужны для локального MVP.

## Безопасность и стоимость

Project/source-version authorization проверяется при upload/read/dispatch/claim.
Права на VOD не означают права на рекламу: отдельное asset-scoped evidence;
local-auto честно маркируется и не принимается manual/production policy.
Bounded streaming upload, admission и scratch budget, строгие media limits,
private objects, no cross-project references. Probe не гарантирует декодирование
каждого кадра: будущий render сохраняет controlled decode failure.
Новые сервисы, платные API и увеличение runtime concurrency не требуются.

## Миграция и rollback

Только additive schema/job enum/FK/checks, без переписывания media или старых
recipes. Runtime deployment отложен до завершения активного capacity batch.
Rollback скрывает новые routes/UI и прекращает admission новых probe jobs.
Перед возвратом старого worker необходимо drain новых типов; таблицы и objects
сохраняются. Старые нарезки и обложки остаются доступны.

## Критерии

Upload → probe → READY → reload/content; corrupt file controlled failure;
retry/duplicate delivery/restart/Redis loss/lease fencing без duplicate effects;
exact checksum/lineage и запрет cross-project reads. Старые SOURCE/CUT_RESULT
не меняются. Следовать task acceptance, независимому review и browser smoke.
