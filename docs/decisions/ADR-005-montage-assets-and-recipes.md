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

## Manual production completion — approved specification, 2026-10-14

Архитектор классифицировал это как предусмотренное завершение ADR-005, без
нового material ADR. **Реализация ещё не принята и начинается только после
текущего security/UI checkpoint.** Нынешний `MONTAGE_RIGHTS_REQUIRED` при manual
policy — намеренный запрет незавершённого local-only пути, не повод ослабить gate.

### Протокол

Существующий multipart upload сохраняет `kind`, `file`, `Idempotency-Key`.
Для ручной аттестации нужны `sourceVersion` текущего исходника, exact
`rightsDeclarationVersion=montage-operator-attestation-v1` и явный
`rightsAttested=true` с одной документированной multipart representation.
Сервер независимо проверяет SourceAuthorization, вычисляет checksum/size и
вместе с upload intent сохраняет `OPERATOR_ATTESTATION`, literal декларации и
свой timestamp. Клиент не задаёт stored basis/time или signer identity.

Это утверждение частного оператора о возможности использовать конкретный
файл для выбранного montage purpose, **не юридическая проверка или доказательство
владения**. Права VOD не подставляют права на этот материал. Окончательная
пользовательская формулировка декларации требует product-owner review перед
production acceptance; реализация/диагностика не утверждают её юридическую силу.

Одна новая canonical additive migration (46-я при сохранении нынешних 45)
заменяет отдельные local-only checks одним exact-pair constraint:

- `LOCAL_DEVELOPMENT_AUTO` / `montage-local-development-auto-v1`;
- `OPERATOR_ATTESTATION` / `montage-operator-attestation-v1`.

Timestamp остаётся обязательным; format/size/status/cleanup/lineage constraints
не снимаются. Старые migration файлы и существующие строки не переписываются.
Новый fingerprint v2 включает meaningful upload context и нормализованное
rights evidence, но не новый timestamp/asset ID. Идентичный replay возвращает
прежний asset и время решения; изменённый context/bytes/kind/declaration
конфликтует. Точный v1 local replay сохраняется только в подходящем local mode;
ручной запрос не повышает старую local запись. Для manual evidence нужен новый
явный upload/asset identity, не автоматический retag.

### Единая eligibility и интерфейс

Manual evidence принимается в обеих поддержанных operating policies только
при независимо usable source. Local evidence — лишь в валидном local-auto.
Unknown/partial/stale evidence и mismatched snapshots запрещены. API/domain/SQL
должны совпадать на creation/finalization/recovery, list/content, recipe inputs,
render admission/read/download, editorial approval, export admission/download,
worker dispatch/claim/input loading и lease-fenced completion. Новая логика не
импортирует API implementation в независимый worker.

Mixed libraries фильтруют неавторизованные rows **до pagination**; direct content
остаётся закрытым. UI checkbox изначально false и сбрасывается при смене файла,
проекта, source version или kind; request использует immutable submission snapshot
и не применяет stale response. Reload/recovery не восстанавливает согласие
молча. Без автоматического клика и наследования SourceAuthorization.
OpenAPI/client получают описанные поля и безопасный rights-status metadata,
без object keys или вымышленного подписанта. Multipart field/part bounds меняются
лишь до точного протокола; staging/admission/deadlines остаются bounded.

### Acceptance и rollback

Нужны fresh/upgrade canonical migration proofs; обе валидные пары принимаются,
mixed/unknown отклоняются, legacy rows неизменны. Отдельно проверить отсутствие/
false/unsupported declaration, stale source, source-only rights, cross-project
references, checksum/context mismatch и local evidence under manual.
Проверить legacy v1 и v2 replay/conflict/concurrency, потерянный ответ и
неоднозначный DB/storage исход без второго asset/probe.

Native manual path при `DEPLOYMENT_PROFILE=other`: ad/intro/outro/banner upload,
background video probe, READY, exact recipe/render, review/approval и background
export/download. Redis loss, SIGKILL, lease/stale finalizer, corrupt media и
storage interruption не создают duplicate/unauthorized READY output. Browser
проверяет сброс checkbox, reload/retry, понятный 403, настоящий manual upload,
timeline/overlay и Range/download. Обязательны relevant large gates и independent
real-diff/reproduced review.

Expiry/revocation, attribution/license documents, verification документов,
re-attestation существующих assets и cross-source reuse не входят. Не выдавать
их за реализованные. JWT/RBAC, public access, paid providers и внешняя публикация
не добавляются. Protected pending API файлы нельзя читать/менять/stage; если
нужное изменение требует этих paths, остановить только этот срез для конкретного
решения владельца, не создавать скрытую копию business implementation.

Rollback прекращает новый manual admission, сохраняет evidence/media/recipes
и widened constraint. Drain/recover admitted jobs до замены совместимых workers;
предпочесть capable binaries с выключенным admission. Destructive down migration
не допускается. Production deployment этим дополнением не разрешён.
