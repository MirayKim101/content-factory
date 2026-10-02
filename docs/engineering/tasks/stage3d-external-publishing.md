# Stage 3D — external publishing and analytics

## Цель

Подключить YouTube и TikTok к уже принятому publishing control plane без
обхода exact human approval, без хранения provider credentials в PostgreSQL и
без риска повторного внешнего POST после неоднозначного результата.

Этот срез завершает локально проверяемую часть Stage 3. Реальная публикация
остаётся отдельным credentialed canary gate для каждого provider/channel.

## Инварианты

- общий `PUBLISHING_ENABLED` и отдельный provider flag должны быть включены
  одновременно; по умолчанию все admission flags выключены;
- intent ссылается только на current exact approval и READY immutable
  horizontal export либо отдельно подтверждённый vertical result;
- credentials приходят из deployment secret/config reference, не сохраняются
  в intent, job payload, API response или log;
- YouTube resumable upload и TikTok Direct Post выполняются через отдельные
  bounded pools, abort-aware deadlines и circuit breakers;
- потерянный ответ после возможного remote commit переводит intent в
  `UNKNOWN_REMOTE_STATE`, а не запускает повторный POST;
- resumable provider session хранится зашифрованно и удаляется только после
  доказанного terminal outcome либо явного operator resolution;
- status reconciliation и metrics collection используют fenced leases;
  просроченный worker не может записать результат или snapshot;
- redirect на credentialed OAuth, API или upload запросах запрещён;
- `LOCAL_DRY_RUN` не называется внешней публикацией и остаётся доступным без
  provider credentials;
- ручной ZIP export не зависит от Stage 3 flags.

## Локальные acceptance criteria

1. При выключенном общем или provider-specific flag API не создаёт runnable
   channel/intent, а worker не выполняет ранее scheduled external intent.
2. Duplicate delivery либо restart продолжает сохранённую resumable session и
   не создаёт вторую публикацию.
3. Однозначная pre-commit transient failure использует bounded backoff;
   неоднозначный post-commit timeout всегда quarantined как
   `UNKNOWN_REMOTE_STATE`.
4. Reconciliation может завершить unknown outcome как `PUBLISHED` или
   `FAILED_FINAL` без повторного upload initiation.
5. Operator resolution без remote ID требует отдельного exact confirmation и
   не доступен при наличии remote ID/result.
6. Lease loss, deadline и shutdown abort-ят OAuth/media/provider I/O; старый
   worker не освобождает и не финализирует lease нового владельца.
7. OAuth token cache привязан к внутреннему channel ID и immutable provider
   identity; смена target identity не переиспользует чужой token.
8. Metrics snapshot записывается только для подтверждённого `PUBLISHED`
   результата и отображается как наблюдение с точным `observedAt`.
9. Channel revoke отменяет только не начатые intents, сохраняет историю и не
   скрывает уже возможный remote outcome.
10. OpenAPI, unit/integration tests, disposable PostgreSQL proof, production
    builds и локальный browser smoke проходят до включения canary.

## Credentialed canary gate

Для каждого provider/channel отдельно:

1. подключить утверждённые OAuth credentials через deployment secret;
2. включить общий и один provider/channel admission flag;
3. опубликовать один специально подготовленный подтверждённый fixture;
4. подтвердить remote ID, публичный status, reconciliation и первый metrics
   snapshot;
5. проверить отсутствие второго remote object после повторной delivery;
6. выключить admission до разбора любого неизвестного результата.

Локальные mock/dry-run проверки не считаются доказательством credentialed
canary.

## Rollback

1. Выключить provider-specific admission, затем общий `PUBLISHING_ENABLED`.
2. Остановить publication worker только после прекращения новых claims.
3. Дать уже начатым attempts завершиться либо перейти в reconciliation.
4. Не удалять durable intents, encrypted sessions, remote IDs, receipts и
   metric snapshots.
5. Сохранить ручной ZIP export и `LOCAL_DRY_RUN` как независимый путь.

## Authority and evidence

- архитектурная граница: `docs/decisions/ADR-010-stage3-ingestion-vertical-publishing-boundaries.md`;
- воспроизводимая локальная приёмка: `docs/engineering/STAGE3-LOCAL-ACCEPTANCE.md`;
- текущий runtime/checkpoint: `docs/engineering/CURRENT-HANDOFF.md`.
