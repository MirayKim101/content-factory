# Stage 3C — AI clip suggestions and human selection

## Цель

Дать оператору безопасный путь от транскрипта исходника до предложенных
интервалов, ручного выбора и обычных cut jobs. AI предлагает только временные
границы; решение о нарезке, vertical render и публикации остаётся раздельным.

## Инварианты

- feature flag по умолчанию выключен, ручная нарезка от него не зависит;
- передача транскрипта внешнему provider требует отдельного явного согласия;
- provider находится за `ClipGenerationProvider`, а durable intent и lease — в
  PostgreSQL;
- очередь переносит только ID, duplicate delivery не создаёт второй набор;
- source version и права проверяются при create, claim, finalize и acceptance;
- shutdown, timeout и lease loss отменяют provider I/O; shutdown возвращает
  intent в очередь без расхода retry budget;
- AI suggestions никогда не считаются approval на vertical render или
  публикацию.

## Acceptance criteria

1. Выключенный flag запрещает новый create до записи строки, но история и
   ручная нарезка доступны.
2. `.env.example` и compose описывают default-off конфигурацию без secrets.
3. UI позволяет запустить генерацию только с валидным transcript и явным
   external-transfer consent, показывает progress/failure и ручной fallback.
4. Одинаковые idempotency key и payload возвращают один intent; изменённый
   payload даёт conflict.
5. Duplicate queue delivery и PostgreSQL recovery дают один suggestion set.
6. Shutdown, provider timeout, lease loss и retry exhaustion воспроизводимы;
   provider получает `AbortSignal`.
7. Выбранные человеком suggestions создают один CutRequest и независимые cut
   jobs; stale lineage отклоняется.
8. Готовые cut artifacts проходят существующие отдельные vertical
   render/approval gates.
9. Unit/API tests, disposable PostgreSQL proof и browser smoke сохранены в
   `STAGE3-LOCAL-ACCEPTANCE.md`.

## Rollback

Выключить `CLIP_GENERATION_ENABLED`, остановить новые claims и дать активному
provider call завершиться либо отмениться через shutdown signal. Durable
intents и suggestions не удалять. Ручной `/cuts` остаётся основным fallback.

## Authority

- `docs/decisions/ADR-010-stage3-ingestion-vertical-publishing-boundaries.md`;
- `docs/product/MVP-ROADMAP.md`;
- `04-AI-MEDIA-SERVICES.md`.
