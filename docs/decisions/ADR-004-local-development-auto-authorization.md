# ADR-004: Local development auto-authorization

- Статус: accepted
- Дата: 2026-09-02
- Область: только локальная разработка
- Уточняет: ADR-003 только для explicit local profile

## Контекст

ADR-003 требует отдельного подтверждения прав на каждую версию исходника. Это
остаётся обязательной production-границей, но в локальном single-owner MVP
диалог мешает многократно проверять загрузку, сетку и нарезку тестовых файлов.

## Решение

Автоматическое разрешение допускается только на сервере при одновременных
настройках `DEPLOYMENT_PROFILE=local`,
`SOURCE_AUTHORIZATION_POLICY=local-auto` и loopback `API_HOST`. Любая другая или
неизвестная конфигурация использует `manual`; попытка local-auto вне local и
loopback завершает startup контролируемой ошибкой.

После успешной финализации exact `(sourceId, sourceVersion)` API атомарно
сохраняет `CLEARED`, basis `LOCAL_DEVELOPMENT_AUTO`, declaration
`local-development-auto-v1`, server timestamp и новую revision. Frontend не
имитирует операторский PUT. API и worker признают этот basis только при активной
local-auto policy. В manual/production такая запись остаётся fail-closed даже
при переносе локальной базы.

## Отклонённые варианты

- auto-click операторского PUT во frontend: создаёт ложную аттестацию;
- удаление DB/API/worker gates: позволяет обход через прямой URL или stale job;
- глобальный auto-clear: небезопасен для production.

## Сохранение текущего поведения

Ручной Dialog и PUT остаются default и production baseline. На локальной машине
этот вариант безопасен, но увеличивает каждый повтор smoke-теста, поэтому
исключение включается только тремя явными настройками.

## Миграция и влияние на данные

Схема получает basis `LOCAL_DEVELOPMENT_AUTO`; существующие решения и
медиафайлы не переписываются. В manual API вычисляет
`authorization.usable=false` для такого evidence даже при status `CLEARED`.
Production preflight должен сбросить эти строки в `NOT_REVIEWED`.

## Безопасность

Браузер не имитирует аттестацию. Startup запрещён, если local-auto сочетается не
с local profile или не с loopback host. Playback, создание/скачивание нарезок,
dispatch и worker claim используют одну policy-aware eligibility.

## Операционная стоимость

Новых сервисов и платной инфраструктуры нет. Стоимость ограничена enum-миграцией,
конфигурационной проверкой и тестами двух режимов.

## Измеримые критерии успеха

- локальная загрузка доступна без дополнительного клика;
- local-auto evidence принимается всеми gate только локально;
- после переключения в manual такой source не воспроизводится и не режется;
- operator/legacy решения сохраняют поведение;
- API, worker, contract и browser smoke проходят до передачи владельцу.

## Rollback и перенос данных

Для возврата ручного режима установить policy `manual` и перезапустить API и
worker. Перед переносом локальной базы все `LOCAL_DEVELOPMENT_AUTO` решения
нужно сбросить в `NOT_REVIEWED`; медиаобъекты миграция не изменяет.

## Проверка

- default/unknown policy остаётся manual;
- local-auto разрешён только на loopback local profile;
- local upload получает exact-version local evidence без browser PUT;
- manual policy не принимает local evidence для playback, cuts, download,
  dispatch или worker claim;
- legacy/operator decisions работают без изменений;
- API и worker тестируют обе политики.
