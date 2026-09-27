# Stage 3C — vertical 9:16 pipeline

## Цель

Создать отдельный, воспроизводимый 9:16 render из готового `CUT_RESULT`, не
изменяя горизонтальный pipeline и не считая машинный render автоматически
одобренным для публикации.

## Инварианты

- admission default-off через `VERTICAL_RENDER_ENABLED`;
- вход — только current source version, cleared authorization, READY cut job и
  READY immutable artifact с совпадающими hash/size lineage;
- job содержит только идентификатор, PostgreSQL остаётся source of truth;
- MVP framing — детерминированный `CENTER_CROP`, 1080×1920, H.264/AAC;
- intent, job, input artifact и result связаны composite foreign keys;
- duplicate delivery не создаёт второй result/artifact;
- vertical result получает отдельный `human-vertical-approval-v1`; horizontal
  approval не переиспользуется;
- до approval результат нельзя передать publishing adapter;
- исходный CUT и ручной ZIP остаются доступными независимо от vertical flag.

## Acceptance criteria

1. Disabled admission возвращает controlled 503 до записи.
2. Same idempotency key + same payload возвращает тот же intent; другой payload
   — conflict.
3. Stale source/cut/artifact отклоняется.
4. FFmpeg output проверяется на точные 1080×1920, codec и duration bounds.
5. Lease loss останавливает encode/upload и не финализирует result.
6. Duplicate queue delivery создаёт один result.
7. Approval возможен только для READY current result.
8. До отдельного approval publishing не принимает vertical result.
