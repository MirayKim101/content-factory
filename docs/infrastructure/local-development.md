# Локальная инфраструктура Stage 1–2

> После переноса Mac → WSL сначала прочитайте [mac-wsl-recovery.md](mac-wsl-recovery.md).
> Приведённый ниже первый запуск относится к пустой совместимой среде, а не к
> сохранённой базе альтернативной WSL-реконструкции.

Эта конфигурация поднимает локальные зависимости первых двух этапов MVP:

- PostgreSQL — постоянное состояние проектов и файловых метаданных;
- Redis — очередь фоновых задач; он не является источником истины;
- MinIO — локальное S3-совместимое хранилище исходных и готовых видео, а также
  private editorial thumbnails;
- `minio-init` — одноразовая выдача отдельной least-privilege учётки API и
  принудительная проверка private bucket. Root credentials использует только
  этот provisioning-контейнер, приложение их не загружает.
- `media-worker` — отдельный non-root процесс FFprobe/FFmpeg. Он получает
  исходник и сохраняет результат только через private S3; его scratch —
  ephemeral tmpfs и не является volume с медиа.

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

   Шаблон также включает явный local-only режим:
   `DEPLOYMENT_PROFILE=local`,
   `SOURCE_AUTHORIZATION_POLICY=local-auto`, `API_HOST=127.0.0.1`. В нём новая
   версия исходника получает отдельное `LOCAL_DEVELOPMENT_AUTO` решение после
   успешной финализации, поэтому диалог подтверждения не показывается. API и
   worker откажутся запускаться с local-auto вне local loopback. Для production
   обязательна policy `manual`; local evidence там остаётся заблокированным.

2. Проверь конфигурацию до запуска:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml config --quiet
   docker compose --env-file .env -f infrastructure/compose.yaml config --services
   ```

   Зачем `--quiet`: обычный вывод `config` содержит раскрытые значения паролей.
   Успех: первая команда завершается без вывода и ошибок, а вторая показывает
   пять сервисов — `postgres`, `redis`, `minio`, `minio-init`, `media-worker`.

3. Собери локальный образ MinIO и запусти зависимости. Worker запускается
   отдельно после additive migration, поэтому не может получить задания до
   готовности схемы:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml up --build --detach \
     postgres redis minio minio-init
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

MinIO policy остаётся least-privilege: API credential имеет object-доступ только
к префиксам `sources/*` и `editorial/*`, bucket остаётся anonymous-private.
Thumbnail нельзя получить прямой публичной ссылкой: чтение выполняется только
через project-scoped API route. После изменения provisioning policy обнови её
без перезапуска MinIO или media-worker:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml run --rm minio-init
```

Успех: команда завершается с кодом `0`, существующие PostgreSQL/MinIO данные и
запущенный media-worker не изменяются.

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
     --form 'file=@/ПОЛНЫЙ/ПУТЬ/К/ВИДЕО.mp4;type=video/mp4'
   ```

   Замени только путь после `@`. Успех: HTTP 201 и JSON со статусом
   `SOURCE_READY` и `source.authorization.status=NOT_REVIEWED`. Поле `sizeBytes` намеренно является строкой: так большие
   значения PostgreSQL `BIGINT` не теряют точность в JavaScript.

4. Скопируй `id` из ответа и проверь сохранённый статус:

   ```sh
   curl --fail-with-body http://127.0.0.1:3001/api/v1/projects/ВСТАВЬ_ID
   ```

   Публичный ответ содержит checksum и lineage, но никогда не раскрывает S3
   bucket/object key или путь временного файла.

5. В стандартном локальном `local-auto` режиме источник уже вернётся как
   `CLEARED / LOCAL_DEVELOPMENT_AUTO`, и просмотр/нарезка станут доступны без
   диалога. В `manual` режиме медиатеки открой диалог подтверждения прав; API-эквивалент —
   `PUT /api/v1/projects/{id}/source-authorization` с текущими
   `sourceVersion`, `expectedRevision`, literal
   `declarationVersion=source-authorization-v1` и `attested=true`.

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

## Запуск фоновой нарезки Stage 1

1. Примени additive migration и запусти API:

   ```sh
   corepack pnpm --filter @content-factory/api db:generate
   corepack pnpm --filter @content-factory/api db:migrate
   corepack pnpm --filter @content-factory/api dev
   ```

   Migration добавляет `CutRequest`, `PipelineJob`, `JobAttempt`, `CutSegment`
   и result lineage, не удаляя существующие проекты или исходники. API
   периодически создаёт probe jobs и возвращает потерянные после Redis/restart
   jobs в очередь из PostgreSQL.

2. В отдельном терминале собери и запусти единственный локальный media worker:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.yaml up --build --detach media-worker
   docker compose --env-file .env -f infrastructure/compose.yaml ps media-worker
   docker compose --env-file .env -f infrastructure/compose.yaml exec media-worker ffmpeg -version
   docker compose --env-file .env -f infrastructure/compose.yaml exec media-worker ffprobe -version
   ```

   Ожидаемый результат: worker имеет статус `running` и `healthy`; обе команды
   версии печатают FFmpeg/FFprobe. Первый лог worker — JSON с
   `event: "media_worker_started"` и `concurrency: 1`. Это безопасный default;
   изменить его можно через `MEDIA_WORKER_CONCURRENCY`, но только после
   измерения CPU, scratch и I/O. Container запускается как встроенный пользователь
   `node`, с read-only root filesystem, без Linux capabilities и без host-port.
   Его временная папка — tmpfs, ограниченный `MEDIA_SCRATCH_SIZE` (default
   `24g`); `MEDIA_SCRATCH_SAFETY_MIB` резервирует свободное место до скачивания
   source. Если Docker Desktop выделил меньше места, job безопасно завершится
   `SCRATCH_ADMISSION_DENIED`, а не заполнит persistent volume.

3. Ещё в одном терминале запусти интерфейс:

   ```sh
   corepack pnpm --filter @content-factory/web dev
   ```

   Открой <http://127.0.0.1:3000/>. После готовой загрузки нажми «Перейти к
   нарезке», дождись FFprobe-длительности, создай два разных отрезка и нажми
   «Запустить нарезку (2)». Ожидаемый результат: две независимые карточки jobs,
   затем две отдельные кнопки «Скачать MP4»; отрезки не склеиваются.

### Проверка результата и контролируемой ошибки

Скачай оба файла и проверь каждый отдельно:

```sh
ffprobe -v error -show_entries format=duration -of default=nw=1 \
  /ПОЛНЫЙ/ПУТЬ/К/СКАЧАННОМУ-cut.mp4
```

Длительность должна совпадать с `endMs - startMs` в пределах обычного допуска
перекодирования одного кадра. Для серверной проверки границ введи конец позже
длительности source: UI блокирует submit, а прямой API-вызов возвращает HTTP
422 `CUT_BOUNDS_INVALID` и не создаёт job. Повреждённый MP4 завершает probe/job
`FAILED_FINAL` с безопасным кодом без object key, FFmpeg command или stack trace.

Проверка restart/idempotency выполняется так: отправь один и тот же неизменённый
submit повторно с тем же `Idempotency-Key`; API возвращает те же job IDs. После
остановки worker дождись истечения `MEDIA_JOB_LEASE_MS` и запусти API/worker:
reconciliation вернёт job в `RETRY_WAIT`, а детерминированный object key и
PostgreSQL unique constraints не позволят создать второй logical result.

BullMQ закреплён как `6.2.2`. Версия проверена 2026-09-02 по официальным
[connection/retry](https://docs.bullmq.io/guide/connections),
[concurrency](https://docs.bullmq.io/guide/workers/concurrency) и
[release](https://github.com/taskforcesh/bullmq/releases) материалам. Queue
несёт только versioned `{schemaVersion, jobId}` reference; бизнес-состояние
остаётся в PostgreSQL.

### Stage 2c: фоновая сборка горизонтального MP4

Stage 2c использует тот же `media-worker` и ту же очередь. Сначала сохрани
exact revision рецепта монтажа, затем создай render intent. Долгая FFmpeg-сборка
не выполняется внутри HTTP-запроса:

```sh
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: render-example-001' \
  --data '{"recipeRevision":1}' \
  http://127.0.0.1:3001/api/v1/pipeline-jobs/CUT_JOB_UUID/assembly-renders
```

Ожидаемый ответ — HTTP `202`: один immutable render ID, exact recipe revision и
fingerprint, снимки входов и PostgreSQL-состояние job. Повтор того же запроса с
тем же ключом возвращает тот же intent; другой body с тем же ключом возвращает
`409`. После создания более новой recipe revision уже принятая сборка остаётся
на исходной exact revision.

Состояние после перезапуска API, worker или браузера читается из PostgreSQL:

```sh
curl http://127.0.0.1:3001/api/v1/assembly-renders/RENDER_UUID
curl 'http://127.0.0.1:3001/api/v1/projects/PROJECT_UUID/assembly-renders?limit=20'
```

Во время обработки ответ содержит attempt-scoped `progress`: phase и реальные
`basisPoints` (0..10000), полученные из скачанных байт и FFmpeg media time. В
`READY` появляется `result.downloadUrl`. Проверка bounded Range и скачивание:

```sh
curl -i -H 'Range: bytes=0-1048575' \
  http://127.0.0.1:3001/api/v1/assembly-renders/RENDER_UUID/content
curl -o horizontal.mp4 \
  http://127.0.0.1:3001/api/v1/assembly-renders/RENDER_UUID/content
ffprobe -v error -show_streams -show_format horizontal.mp4
```

Успех: Range возвращает `206` и `Content-Range`; полный файл содержит один
H.264/yuv420p video stream и один AAC stereo 48 kHz audio stream. Порядок
сборки — intro, cut до рекламной точки, advertisement, остаток cut, outro.
Static banners и CTA видны только на cut-local интервалах.

Для воспроизводимого локального профиля оставь
`MEDIA_WORKER_CONCURRENCY=1`, `FFMPEG_THREADS=2` и pinned
`ASSEMBLY_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`.
Недостаток scratch оставляет job в `QUEUED` с `admissionReason` и не расходует
attempt. Retry использует PostgreSQL `nextAttemptAt`; потеря Redis или restart
восстанавливаются reconciler-ом. Не включай API admission со старым worker:
сначала должна быть развёрнута версия worker, понимающая
`ASSEMBLE_HORIZONTAL`. Перед production rollout обязательны independent CLEAN
review, disposable tiny-media smoke, controlled corrupt-input test и отдельный
30-минутный benchmark; этот runbook не разрешает применять миграцию к live базе.

### Stage 2e: background editorial ZIP64 package

Stage 2e использует тот же `media-worker`, PostgreSQL, Redis и private object
storage. API только сохраняет intent/job и отправляет короткую queue reference;
весь большой архив потоково создаёт worker. До independent CLEAN оставь
`EDITORIAL_EXPORT_ENABLED=0`.

После разрешённого rollout current approval запускает export так:

```sh
curl -i -X POST \
  -H 'Idempotency-Key: export-example-001' \
  http://127.0.0.1:3001/api/v1/editorial-approvals/APPROVAL_UUID/exports
curl http://127.0.0.1:3001/api/v1/editorial-exports/EXPORT_UUID
curl 'http://127.0.0.1:3001/api/v1/projects/PROJECT_UUID/editorial-exports?limit=20'
```

Ожидаемый POST — `202`; повтор exact запроса с тем же key возвращает тот же
export. Status после reload берётся из PostgreSQL и содержит attempt-scoped
реальный byte progress. Когда state станет `READY`, проверь Range и скачивание:

```sh
curl -i -H 'Range: bytes=0-1048575' \
  http://127.0.0.1:3001/api/v1/editorial-exports/EXPORT_UUID/content
curl -o editorial-package.zip \
  http://127.0.0.1:3001/api/v1/editorial-exports/EXPORT_UUID/content
unzip -Z1 editorial-package.zip
unzip -t editorial-package.zip
```

Архив должен содержать ровно `video.mp4`, одну `thumbnail.jpg|png|webp`,
`metadata.txt`, `metadata.json`, `manifest.json`. Stale approval, отозванные
права и изменённые exact inputs закрывают claim/finalization/download. Scratch
attempt сохраняет marker без raw lease token; startup и periodic reconciler
сохраняют active lease любого worker и удаляют только подтверждённый PostgreSQL
expired orphan после safety grace. Admission accounting перестраивается из
local markers и PostgreSQL active reservations; недоступная БД блокирует этот
startup gate. Export upload использует один atomic streaming `PutObject`, чтобы
hard kill не оставлял multipart parts без durable upload ID. Максимальный
archive для этого Stage 2 профиля — `5_000_000_000` bytes; больший архив
завершается controlled ошибкой `EXPORT_SINGLE_UPLOAD_LIMIT_EXCEEDED`.

Для rollout сначала разверни worker и найди в JSON startup log capability
`EXPORT_EDITORIAL_PACKAGE`. Только затем разверни API/frontend и включи
`EDITORIAL_EXPORT_ENABLED=1`. Сначала выполни короткий disposable export и
tampered-input failure, затем один approved 30-minute package. Rollback:
выключить flag, drain/controlled-finalize export jobs и использовать только
сохранённые forward-compatible admission-off API/worker binaries; additive
таблицы, historical results и private objects не удалять.

Rollback compatibility gate внутри worker isolated suite сначала собирает и
запускает реальные `apps/api/dist/main.js` и `apps/worker/dist/main.js` с
`--verify-admission-off-rollback`. Проверка обязана пройти против migrated
disposable PostgreSQL при `EDITORIAL_EXPORT_ENABLED=0`: terminal export остаётся
read-only, не dispatch/claim, startup scratch reconciliation проходит, а
source/cut/editorial/montage/recipe/render rows и runnable job types остаются
совместимыми.

### Docker runtime: версии, логи и controlled startup failure

`media-worker` использует официальный multi-architecture Node image
`node:24.15.0-bookworm-slim` с immutable index digest
`sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d`.
FFmpeg закреплён на Debian Bookworm security version
`7:5.1.9-0+deb12u1`. Выбор проверен 2026-09-02 по
[Node Docker image](https://github.com/nodejs/docker-node),
[Docker digest guidance](https://docs.docker.com/build/policies/examples/#pin-base-images-to-digests)
и [Debian FFmpeg source package](https://sources.debian.org/src/ffmpeg/).
Образ не использует floating tags; build выполняется через сохранённый
`pnpm-lock.yaml`.

Worker пишет JSON-lines в Docker local log driver, который хранит максимум три
файла по 10 MiB. Посмотреть последние безопасные операционные события можно
так:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml logs --tail=100 media-worker
```

Не выполняй `docker compose config` без `--quiet`: он может вывести значения из
`.env`. Для воспроизводимой проверки отсутствующего binary используй временный
container — он завершится с JSON `FFMPEG_UNAVAILABLE` и кодом `78`, не печатая
credentials:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml run --rm --no-deps \
  -e FFMPEG_PATH=/not-present/ffmpeg media-worker
```

Для проверки отсутствующей обязательной настройки временно замени только её в
этой команде. Ожидаемый безопасный результат — `CONFIG_S3_SECRET_KEY_REQUIRED`:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml run --rm --no-deps \
  -e S3_SECRET_KEY= media-worker
```

Оба вызова не запускают job и не меняют PostgreSQL, Redis или MinIO.

## Маршрут API через локальный интерфейс

Frontend обращается только к относительному `/api/v1`. В development Nuxt/Vite
направляет этот путь на фиксированный `http://127.0.0.1:3001` без изменения
версии API. Это локальный эквивалент будущего same-origin edge routing на VDS,
а не Nitro BFF: proxy не содержит DTO, Zod-схем или бизнес-логики.

Для проверки сначала запусти API на порту 3001, затем frontend на порту 3000.
Запрос из браузера к `http://localhost:3000/api/v1/projects` должен попасть в
NestJS без CORS preflight. Production reverse proxy и его streaming/timeout
настройки будут добавлены отдельным infrastructure slice до развёртывания VDS;
порт NestJS нельзя открывать публично.

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
должен снова стать `healthy`; `minio-init` остаётся завершённым с кодом `0`.
При `docker compose down` worker сначала получает `SIGTERM` и до 45 секунд
закрывает BullMQ intake; если активный FFmpeg не успел завершиться, lease и
reconciliation безопасно вернут job в очередь после следующего запуска. Если
сервис не стал healthy, сначала посмотри только его логи:

```sh
docker compose --env-file .env -f infrastructure/compose.yaml logs --tail=100 minio
```

Замени `minio` на `postgres`, `redis` или `media-worker`, если проблема в другом
сервисе.

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

`media-worker` не имеет persistent volume: source/result доступны между
запусками только через S3-compatible MinIO. Его tmpfs scratch не входит в
backup и намеренно исчезает при остановке container; задача восстановится по
PostgreSQL lease/reconciliation.

Volume — это защита от обычного перезапуска, но не backup. Пока в проекте нет
пользовательских данных, достаточно убедиться, что volumes сохраняются после
`down`/`up`. До первой реальной загрузки видео нужно утвердить отдельную
процедуру backup: дамп PostgreSQL плюс S3-level копирование MinIO с проверкой
восстановления. Redis в backup не входит: очередь восстанавливается из
PostgreSQL, который остаётся источником истины.

## Откат этой инфраструктурной версии

Чтобы вернуться к предыдущему состоянию кода, верни только файлы
`infrastructure/`, `.env.example` и этот документ через обычный Git review.
Для отдельного rollback editorial storage сначала останови новые thumbnail
uploads, затем убери только resource `editorial/*` из API policy и повторно
запусти одноразовый `minio-init`. Это закрывает доступ API к thumbnail objects,
но не удаляет сами objects или другие данные; доступ к `sources/*` не меняется.
Чтобы остановить уже запущенные контейнеры без потери данных, используй `down`
выше. Не удаляй volumes, пока не создана и не проверена резервная копия.

## Откат миграции загрузки

Prisma не выполняет автоматический destructive rollback. Безопасный откат кода
оставляет новые пустые таблицы на месте: предыдущая версия API их не использует.
Если в них уже есть реальные данные, сначала сохрани PostgreSQL dump и объекты
bucket, затем делай forward-миграцию или восстанавливай проверенный backup.
Удалять таблицы и bucket вручную нельзя. До первой реальной загрузки резервное
копирование PostgreSQL и S3 остаётся обязательным следующим операционным шагом.

Для отката именно нарезки сначала останови `@content-factory/worker`, затем
отключи создание новых cut jobs на уровне кода/API. Additive таблицы, job rows и
result objects не удаляй: предыдущий upload-срез их игнорирует, а данные нужны
для forward-fix и повторного reconciliation. Destructive down migration для
реальных source/result данных не поддерживается.
