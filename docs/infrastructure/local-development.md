# Локальная инфраструктура Stage 1

Эта конфигурация поднимает только локальные зависимости первого этапа MVP:

- PostgreSQL — постоянное состояние проектов и файловых метаданных;
- Redis — очередь фоновых задач; он не является источником истины;
- MinIO — локальное S3-совместимое хранилище исходных и готовых видео;
- `minio-init` — одноразовая выдача отдельной least-privilege учётки API и
  принудительная проверка private bucket. Root credentials использует только
  этот provisioning-контейнер, приложение их не загружает.

Контейнеры называются с префиксом `content-factory`, данные лежат в Docker
volumes с тем же префиксом. Порты доступны только с этого компьютера
(`127.0.0.1`), не из локальной сети.

## Первый запуск

1. В корне проекта создай личный файл настроек:

   ```sh
   install -m 600 .env.example .env
   ```

   Зачем: настоящий `.env` не попадёт в Git. Открой его и замени все значения
   `CHANGE_ME_...` на разные длинные пароли. Для локального MVP подойдёт
   команда `openssl rand -base64 24`, выполненная отдельно для каждого пароля.

2. Проверь конфигурацию до запуска:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml config --quiet
   docker compose --env-file .env -f infrastructure/compose.yaml config --services
   ```

   Зачем `--quiet`: обычный вывод `config` содержит раскрытые значения паролей.
   Успех: первая команда завершается без вывода и ошибок, а вторая показывает
   четыре сервиса — `postgres`, `redis`, `minio`, `minio-init`.

3. Собери локальный образ MinIO и запусти зависимости:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml up --build --detach
   ```

   Первый запуск может занять несколько минут: MinIO Community собирается из
   закреплённого исходного релиза. Это намеренно — официальный проект больше не
   публикует готовый Community container image.

4. Убедись, что всё готово:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml ps
   ```

   Успех: PostgreSQL, Redis и MinIO имеют статус `running` и `healthy`, а
   одноразовый `minio-init` завершается с кодом `0`. Консоль MinIO
   открывается на <http://127.0.0.1:9001>; используй `MINIO_ROOT_USER` и
   `MINIO_ROOT_PASSWORD` из своего `.env`.

## Проверка без интерфейса

После статуса `healthy` выполни по очереди:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml exec postgres \
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT 1;"
```

```sh
docker compose --env-file .env -f infrastructure/compose.yaml exec redis \
  redis-cli --no-auth-warning --user default --pass "$REDIS_PASSWORD" ping
```

```sh
curl --fail http://127.0.0.1:9000/minio/health/ready
```

Ожидаемые результаты: первая команда покажет `1`, вторая — `PONG`, третья
завершится без текста и без ошибки. Перед этими командами загрузи переменные в
текущий терминал командой `set -a; source .env; set +a` или выполни проверки из
интерфейса приложения на следующем шаге.

## Первый запуск API загрузки

1. Сгенерируй Prisma Client и примени уже сохранённые миграции:

   ```sh
   corepack pnpm --filter @content-factory/api db:generate
   corepack pnpm --filter @content-factory/api db:migrate
   ```

   Зачем: первая команда создаёт типобезопасный клиент из схемы, вторая создаёт
   таблицы `Project`, `VideoSource` и `MediaArtifact`. Успех: Prisma сообщает,
   что migration применена и база синхронизирована.

2. Запусти API из корня проекта:

   ```sh
   corepack pnpm --filter @content-factory/api dev
   ```

   Ожидаемый результат: Nest показывает маршруты `POST /api/v1/projects` и
   `GET /api/v1/projects/:id`. Интерактивное описание API доступно на
   <http://127.0.0.1:3001/api/docs>, JSON-контракт — на
   <http://127.0.0.1:3001/api/docs-json>.

3. Пока интерфейс ещё не сделан, загрузи собственный или разрешённый MP4 из
   второго терминала:

   ```sh
   curl --fail-with-body --request POST http://127.0.0.1:3001/api/v1/projects \
     --header 'Idempotency-Key: upload-2026-09-01-001' \
     --form 'name=Первый исходник' \
     --form 'rightsConfirmed=true' \
     --form 'file=@/ПОЛНЫЙ/ПУТЬ/К/ВИДЕО.mp4;type=video/mp4'
   ```

   Замени только путь после `@`. Успех: HTTP 201 и JSON со статусом
   `SOURCE_READY`. Поле `sizeBytes` намеренно является строкой: так большие
   значения PostgreSQL `BIGINT` не теряют точность в JavaScript.

4. Скопируй `id` из ответа и проверь сохранённый статус:

   ```sh
   curl --fail-with-body http://127.0.0.1:3001/api/v1/projects/ВСТАВЬ_ID
   ```

   Публичный ответ содержит checksum и lineage, но никогда не раскрывает S3
   bucket/object key или путь временного файла.

### Что API гарантирует на этом шаге

- принимает только один MP4 размером до `API_MAX_UPLOAD_BYTES` (по умолчанию
  10 GiB) и проверяет ISO BMFF, непустой `mdat`, `moov`, metadata видеотрека,
  video sample description и согласованность `stsc`/`stsz`/`stco` с байтами
  внутри `mdat`, а не имя или MIME; это ещё не проверка декодером — FFprobe
  остаётся следующим worker-шагом;
- использует отдельную папку `request-*` с правами `0700`, файл `0600` и
  удаляет папку при успехе, ошибке, malformed multipart или disconnect;
  startup sweep ограниченно удаляет только собственные папки старше TTL;
- сначала атомарно записывает `SOURCE_PENDING` в PostgreSQL, затем загружает в
  приватный bucket и атомарно завершает `SOURCE_READY`;
- при сбое хранилища или финализации ставит стабильный `FAILED_FINAL` и
  сохраняет retryable cleanup intent; неудачное удаление объекта остаётся в
  PostgreSQL и повторяется reconciliation, а не теряется в логах;
- при старте обрабатывает ограниченное число устаревших `SOURCE_PENDING`: если
  объект существует с ожидаемыми размером и SHA-256 metadata, завершает запись;
  если нет или integrity не совпадает — ставит контролируемую ошибку. Реальный
  После deadline `AbortSignal` не даёт начать следующий storage/DB шаг или
  следующий элемент. Уже начавшаяся транзакция PostgreSQL может завершиться:
  HTTP-процесс не заявляет, что умеет отменять in-flight DB transaction.

`Idempotency-Key` обязателен. Повтор с тем же ключом и тем же именем/файлом
возвращает тот же проект в его текущем `SOURCE_PENDING`, `SOURCE_READY` или
`FAILED_FINAL`, не создавая второй объект. Тот же ключ с другим payload даёт
HTTP 409 `IDEMPOTENCY_CONFLICT`. Terminal-переходы выполняются compare-and-set:
READY нельзя превратить в FAILED и наоборот; повтор того же перехода безопасен.

Контролируемые ошибки возвращаются как
`{"error":{"code":"...","message":"..."}}`: отсутствие подтверждения прав
даёт HTTP 400, конфликт ключа — 409, неверное MP4-содержимое — 415, превышение
размера — 413, storage failure — 503. Все эти ответы описаны в OpenAPI.

Проверка реализации:

```sh
corepack pnpm --filter @content-factory/api test
corepack pnpm --filter @content-factory/api test:integration
```

Integration-набор использует реальные локальные PostgreSQL и MinIO, создаёт
маленький MP4 в памяти, проверяет запись и объект, а затем удаляет созданные им
данные.

## Остановка, перезапуск и ошибки

Остановить контейнеры, сохранив данные:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml down
```

Запустить их снова:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml up --detach
```

Политика `unless-stopped` автоматически перезапускает сервис после неожиданного
падения или перезапуска Docker. После перезапуска проверь `ps`: каждый сервис
должен снова стать `healthy`. Если сервис не стал healthy, сначала посмотри
только его логи:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml logs --tail=100 minio
```

Замени `minio` на `postgres` или `redis`, если проблема в другом сервисе.

Две частые и контролируемые ошибки:

- `port is already allocated` означает, что этот порт уже занят другой локальной
  программой. Останови известную программу или измени только число **слева** в
  строке порта `127.0.0.1:5432:5432` в `infrastructure/compose.yaml`, затем
  снова выполни `up --detach`. Число справа — внутренний порт сервиса, его не
  меняем.
- `POSTGRES_PASSWORD` применяется только при первой инициализации пустого
  PostgreSQL volume. Его простая замена в `.env` не меняет пароль существующего
  пользователя базы. У Redis и MinIO пароль читается из `.env` при каждом
  старте контейнера, поэтому их новые значения начинают действовать после
  пересоздания контейнеров. Не меняй никакие credentials без согласованной
  ротации настроек приложения и проверки доступа к существующим данным.

## Данные и backup

`postgres-data`, `redis-data` и `minio-data` — постоянные Docker volumes.
Обычная команда `down` их **не удаляет**. Никогда не используй `down --volumes`
для рабочего MVP: она безвозвратно удалит локальную базу и медиафайлы.

Volume — это защита от обычного перезапуска, но не backup. Пока в проекте нет
пользовательских данных, достаточно убедиться, что volumes сохраняются после
`down`/`up`. До первой реальной загрузки видео нужно утвердить отдельную
процедуру backup: дамп PostgreSQL плюс S3-level копирование MinIO с проверкой
восстановления. Redis в backup не входит: очередь восстанавливается из
PostgreSQL, который остаётся источником истины.

## Откат этой инфраструктурной версии

Чтобы вернуться к предыдущему состоянию кода, верни только файлы
`infrastructure/`, `.env.example` и этот документ через обычный Git review.
Чтобы остановить уже запущенные контейнеры без потери данных, используй `down`
выше. Не удаляй volumes, пока не создана и не проверена резервная копия.

## Откат миграции загрузки

Prisma не выполняет автоматический destructive rollback. Безопасный откат кода
оставляет новые пустые таблицы на месте: предыдущая версия API их не использует.
Если в них уже есть реальные данные, сначала сохрани PostgreSQL dump и объекты
bucket, затем делай forward-миграцию или восстанавливай проверенный backup.
Удалять таблицы и bucket вручную нельзя. До первой реальной загрузки резервное
копирование PostgreSQL и S3 остаётся обязательным следующим операционным шагом.
