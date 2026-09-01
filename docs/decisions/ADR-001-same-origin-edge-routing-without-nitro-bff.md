# ADR-001: Same-origin edge routing without a Nitro BFF

- Статус: accepted
- Дата: 2026-09-01
- Автор решения: Content Factory architect
- Reviewer / approver: owner

## Проблема и доказательства

Локальная SPA и NestJS API работают на разных портах, а будущий VDS должен
предоставить браузеру один защищённый origin без зависимости от CORS. Исходные
видео могут достигать 10 GiB, поэтому дополнительный прикладной proxy-hop не
должен буферизовать multipart или дублировать backend-логику.

## Текущие ограничения

- Nuxt SPA и NestJS остаются независимыми приложениями;
- OpenAPI NestJS — единственный контракт API;
- исходный upload идемпотентен и может продолжиться на сервере после потери
  клиентского соединения;
- VDS в любом случае требует TLS termination и ограничения приватного API.

## Варианты

### Вариант A: разные origins и CORS

Прост локально, но добавляет browser policy и конфигурацию allowlist при каждом
развёртывании.

### Вариант B: Nitro BFF

Даёт same-origin, но добавляет второй Node.js hop для больших файлов, новые
timeout, buffering, disconnect и header risks. Сейчас BFF нечего агрегировать,
а DTO и бизнес-правила дублировать запрещено.

### Вариант C: same-origin edge routing

Один публичный origin обслуживает SPA по `/`, а `/api/v1/**` потоково направляет
в приватный NestJS API. Локально эквивалентный относительный маршрут реализует
только dev proxy Nuxt/Vite. Выбран этот вариант.

## Последствия

- браузер и сгенерированный OpenAPI client используют относительный `/api/v1`;
- edge proxy не знает DTO и не содержит бизнес-логики;
- production request buffering выключен, upstream задан конфигурацией и не
  управляется пользовательским вводом;
- proxy сохраняет `Idempotency-Key`, content headers и request ID, а входящим
  `X-Forwarded-*` не доверяет;
- edge upload limit немного выше `API_MAX_UPLOAD_BYTES`, чтобы штатный JSON
  `413` формировал NestJS;
- proxy timeout не короче документированного upload/finalization deadline;
- наружу открыт один TLS origin, NestJS доступен только в private network;
- при будущей cookie-auth отдельно обязательны Origin/Fetch Metadata checks,
  `SameSite`, `Secure` и защита CSRF.

## Миграция

1. Использовать относительный API base URL во frontend.
2. Добавить фиксированный dev-only proxy `/api/v1/** -> 127.0.0.1:3001`.
3. Перед VDS оформить и проверить production edge configuration отдельным
   infrastructure slice.
4. Не включать CORS `*` и не открывать порт NestJS публично.

## Rollback

Вернуть frontend к абсолютному API URL и строгому CORS allowlist. Изменений базы
данных или API-контракта для отката не требуется.

## Критерии успеха

- браузер вызывает только same-origin `/api/v1/**` без CORS preflight;
- multipart проходит proxy потоково с ограниченным потреблением памяти;
- NestJS status, response body, content type и безопасные ошибки сохраняются;
- повтор после потерянного ответа с тем же ключом возвращает тот же проект;
- double submit не создаёт второй проект или S3 object;
- `413`, disconnect и proxy `502/504` воспроизводятся контролируемо;
- независимый reviewer проверяет реальный diff и пользовательский сценарий.

## Решение tech lead

Одобрён вариант C. Nitro BFF отложен до измеримой потребности: application
session authentication, browser-hidden credentials или агрегация нескольких
backend API.
