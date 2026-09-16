# Изолированный WSL runtime восстановленной версии

Статус: локальная среда восстановлена 2026-09-16. Она использует Mac migration
line из ADR-009 и никогда не подключается к legacy WSL database или object
storage. Это локальная development-среда; production edge routing остаётся
отдельным infrastructure slice по ADR-001.

## Граница данных

Команда Compose всегда должна содержать оба файла и точное имя проекта:

```sh
docker compose --project-name content-factory-restored --env-file .env \
  -f infrastructure/compose.yaml -f infrastructure/compose.restored.yaml
```

Итоговые ресурсы имеют только префикс `content-factory-restored`:

| Ресурс        | Локальный адрес                    | Назначение                                        |
| ------------- | ---------------------------------- | ------------------------------------------------- |
| PostgreSQL    | `127.0.0.1:15432`                  | база `content_factory_restored`                   |
| Redis         | `127.0.0.1:16379`                  | очередь `content-factory-restored-media-v1`       |
| MinIO API     | `127.0.0.1:19000`                  | private bucket `content-factory-restored-sources` |
| MinIO console | `127.0.0.1:19001`                  | только для локального оператора                   |
| network       | `content-factory-restored-network` | связи только новых контейнеров                    |

Overlay применяет Compose `!override` для `ports`; базовые `5432`, `6379`,
`9000` и `9001` в этой среде не публикуются. Tomа называются
`content-factory-restored-{postgres,redis,minio}-data`. Не добавляй legacy env,
старые bucket, database, volumes или queue name в этот запуск.

## Первый запуск

1. Создай локальный env ровно один раз. Скрипт создаёт независимые случайные
   credentials, выставляет права `0600`, включает local-only authorization и
   оставляет `AI_CONTEXT_ENABLED=0`. Он останавливается, если `.env` уже есть.

   ```sh
   node infrastructure/create-restored-runtime-env.mjs
   ```

2. Проверь собранную конфигурацию без печати env и подними новые зависимости:

   ```sh
   docker compose --project-name content-factory-restored --env-file .env \
     -f infrastructure/compose.yaml -f infrastructure/compose.restored.yaml config --quiet
   docker compose --project-name content-factory-restored --env-file .env \
     -f infrastructure/compose.yaml -f infrastructure/compose.restored.yaml \
     up --build --detach postgres redis minio minio-init
   ```

3. Примени миграции только после healthy PostgreSQL. Используй закреплённый
   Node из `tmp/runtime`:

   ```sh
   PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
   COREPACK_HOME="$PWD/tmp/runtime/corepack" \
   pnpm --filter @content-factory/api db:generate
   PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
   COREPACK_HOME="$PWD/tmp/runtime/corepack" \
   pnpm --filter @content-factory/api db:migrate
   ```

4. Запусти worker после миграций:

   ```sh
   docker compose --project-name content-factory-restored --env-file .env \
     -f infrastructure/compose.yaml -f infrastructure/compose.restored.yaml \
     up --build --detach media-worker
   ```

5. В двух отдельных terminals запусти API и локальную UI с same-origin dev
   proxy. API слушает только `127.0.0.1:3001`, UI — только `127.0.0.1:3000`.
   Перед первым API запуском собери его:

   ```sh
   PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
   COREPACK_HOME="$PWD/tmp/runtime/corepack" \
   pnpm --filter @content-factory/api build
   ```

   ```sh
   PATH="$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
   node apps/api/dist/main.js
   ```

   ```sh
   PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
   COREPACK_HOME="$PWD/tmp/runtime/corepack" \
   pnpm --dir apps/web exec nuxt dev --port 3000 --host 127.0.0.1
   ```

Открой <http://127.0.0.1:3000>. `GET /api/v1/health` через этот origin должен
вернуть `{"status":"ok"}`. Nuxt production output сам по себе не заменяет
edge proxy: для local UI используется именно dev proxy из ADR-001.

## Creator Context в проверенной local среде

После приёмки Stage 2B-1 API использует `AI_CONTEXT_ENABLED=1` в локальном
`.env`. Для Nuxt передай этот флаг явно: запуск из `apps/web` не читает корневой
`.env` автоматически.

```sh
PATH="$PWD/tmp/runtime/bin:$PWD/tmp/runtime/node-v24.15.0-linux-x64/bin:$PATH" \
COREPACK_HOME="$PWD/tmp/runtime/corepack" AI_CONTEXT_ENABLED=1 \
pnpm --dir apps/web exec nuxt dev --port 3000 --host 127.0.0.1
```

Это включает только профили, private reference, контекст и prompt. Внешних
AI-провайдеров и генерации нет. Изменение флага требует перезапуска API/web;
отключение обоих флагов сохраняет данные и ручной Stage 2. MinIO provisioning
разрешает только отдельный creator-reference namespace; первый API startup
выполняет durable reference reconciliation. Evidence:
`docs/engineering/CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md`.

## Проверки и evidence этого запуска

- `config --quiet` прошла; итоговая конфигурация содержит только порты
  `15432`, `16379`, `19000`, `19001`.
- Новая PostgreSQL получила 15 migration из Mac baseline, включая
  `20260906234500_creator_context_foundation`.
- PostgreSQL, Redis, MinIO и `media-worker` имеют `healthy`; `minio-init`
  завершился с кодом `0`. Worker стартовал с отдельной queue и возможностями
  source probe, cut, assembly и export.
- Synthetic six-second MP4 прошёл upload → private S3 → probe → local-auto
  authorization → cut 1000–4000 ms → ready result. Скачанный MP4 успешно
  проверен FFprobe, duration `3.000000`, SHA-256
  `76b2dff4c441a0241959e81397f05623edecc7087996908c83e5b0bd2713419f`.
- Невалидный cut с концом после source duration дал HTTP `422`
  `CUT_BOUNDS_INVALID`, не бесконечное задание.

При первой проверке AI context и editorial export были выключены. Затем
manual export включён для synthetic Stage 2 smoke, см.
[отчёт](../engineering/RESTORED-MANUAL-PIPELINE-SMOKE.md). AI context затем
включён для отдельной приёмки, описанной выше. External providers остаются
выключены. Локальная приёмка не означает production rollout.

## Остановка и rollback

Остановить только новую среду без удаления данных:

```sh
docker compose --project-name content-factory-restored --env-file .env \
  -f infrastructure/compose.yaml -f infrastructure/compose.restored.yaml stop
```

Для повторного запуска выполни те же `up --detach` команды. Не используй
`down --volumes` без отдельного решения о безвозвратном удалении именно трёх
томов `content-factory-restored-*`. Откат к alternate WSL line остаётся
branch/runtime операцией из `mac-wsl-recovery.md`; он не включает перенос или
перезапись данных этой изолированной базы.
