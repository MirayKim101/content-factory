# ADR-003: Source-version authorization gate

- Статус: accepted
- Дата: 2026-09-02
- Автор решения: Solution Architect — Source Authorization
- Reviewer / approver: Manager / owner

## Проблема

Подтверждение прав при загрузке было полем проекта и смешивало передачу байтов
с решением оператора. Его можно было подставить клиентом автоматически, оно не
следовало за версией исходника и не давало надёжной fail-closed границы перед
просмотром, обработкой и скачиванием результата.

## Решение

Каждая `(sourceId, sourceVersion)` имеет отдельную `SourceAuthorization`.
Новый исходник создаётся как `NOT_REVIEWED` без решения и может перейти только
в `CLEARED` по явной операторской аттестации версии
`source-authorization-v1`. Решение хранит basis, declaration version, server
timestamp и monotonic revision. Поля решения либо все `NULL` для
`NOT_REVIEWED`, либо все заполнены для `CLEARED`; это защищено DB CHECK.

Старые исходники backfill-ятся как `CLEARED / LEGACY_ATTESTATION` с точными
старыми timestamp и declaration version. Deprecated поля Project становятся
nullable и остаются только для обратной совместимости чтения. Новые загрузки
игнорируют старое необязательное `rightsConfirmed` и получают fingerprint v2;
повтор существующего v1 fingerprint продолжает работать.

`PUT /api/v1/projects/:projectId/source-authorization` принимает sourceVersion,
expectedRevision, literal declarationVersion и `attested: true`. Повтор уже
принятого идентичного решения идемпотентен. Устаревшая версия source или revision
возвращают разные `409`, неподдерживаемая декларация — `422`, неготовый source —
`409`.

Playback исходника, создание cuts, скачивание результата, dispatch и worker
claim разрешены только для полной `CLEARED` записи точной версии. Неизвестное,
отсутствующее или частичное состояние трактуется как запрет. Cut gate находится
в той же PostgreSQL transaction, что и создание intent, поэтому отказ не
оставляет `CutRequest`, jobs или segments.

## Последствия и rollback

Авторизация не отзывается в этом срезе; revoke, bulk authorization, RBAC,
Twitch/AI и mobile отложены. Откат приложения безопасен только вместе с
сохранением новой таблицы: её удаление потеряет решения. Для функционального
rollback можно оставить чтение таблицы и временно скрыть PUT/UI, не снимая gate.
