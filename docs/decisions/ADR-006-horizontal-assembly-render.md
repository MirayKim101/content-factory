# ADR-006: Deterministic horizontal assembly render

- Статус: accepted
- Дата: 2026-09-06
- Автор решения: Solution Architect — Horizontal Assembly Render
- Reviewer / approver: Independent Reviewer — Montage Recipe (2026-09-06)
- Область: Stage 2c, локальная фоновая сборка горизонтального MP4

## Проблема и доказательства

Stage 2 требует после сохранения immutable montage assets и exact assembly
recipe создать новый горизонтальный MP4, не изменяя исходную нарезку и ресурсы.
Product sequence отдельно требует idempotent background job, progress, retry,
restart-safety и lineage до всех точных входных revisions.

ADR-005 разрешает отдельный render slice в существующем `editorial-content` и
media-worker, фиксирует cut-local timeline и запрещает raw FFmpeg arguments. Он
не определяет durable render intent/result, FFmpeg graph, нормализацию звука,
generalized progress, retry backoff, resource admission и безопасный порядок
rollout нового job type. Без этих решений реализация может:

- при retry или Redis loss собрать другую `currentRevision`;
- создать несколько logical outputs для одного intent;
- оставить неавторитетный объект после lease loss;
- исчерпать scratch/CPU при параллельной нарезке и сборке;
- показать фиктивный progress или бесконечно ожидающее состояние;
- принять произвольные filter/codec arguments либо небезопасный CTA text.

Текущая модель уже хранит immutable `AssemblyRecipeRevision`, exact cut snapshot
и нормализованные asset snapshots. BullMQ доставляет только ссылку на job, а
PostgreSQL остаётся authoritative state. Эти seams следует расширить, а не
создавать второй pipeline.

## Текущие ограничения

- Nuxt и NestJS остаются независимыми за versioned REST/OpenAPI contract.
- FFmpeg никогда не выполняется внутри HTTP request.
- PostgreSQL authoritative; Redis/BullMQ — disposable coordination.
- Используются существующие object storage и independently runnable
  media-worker; новый сервис, очередь или платный provider не требуются.
- Worker должен быть idempotent, restart-safe и lease-fenced.
- Один cut, не более одного intro, outro и advertisement, до восьми static
  banners и один CTA определены recipe v1.
- Timeline остаётся `intro -> cut[0,t) -> ad -> cut[t,D) -> outro`; banner/CTA
  применяются только к cut-local timeline.
- Локальный безопасный default — один heavy FFmpeg slot. Увеличение concurrency
  допускается только после отдельного benchmark.
- Mobile, approval, export package, AI, Twitch, vertical и publishing не входят
  в этот slice.

## Варианты

### Вариант A: сохранить только recipe, без render

Плюсы: нет миграции, нового job type, CPU и storage cost. Минусы: Stage 2 не
создаёт готовое видео, поэтому оператор вынужден вручную повторять montage во
внешнем редакторе. Product outcome не достигнут.

### Вариант B: синхронная сборка в API

Плюсы: меньше явных job сущностей. Минусы: долгий HTTP request, невозможность
надёжного retry/recovery, риск buffering и исчерпания API CPU/scratch. Вариант
противоречит architecture baseline и отклонён.

### Вариант C: внешний editor/render provider

Плюсы: возможны сложные transitions и animated templates. Минусы: платная
зависимость, upload больших private media, provider limits, другая failure model
и потеря локального MVP. Для static overlays и concat это неоправданно;
пересмотр возможен только после отдельного benchmark и port/ADR.

### Вариант D: existing worker + owned deterministic FFmpeg adapter

Плюсы: сохраняет один durable pipeline, текущие leases/reconciliation/storage,
не требует платного сервиса и масштабируется добавлением bounded workers.
Минусы: требуется additive schema, exact render contract, output validation и
реальный capacity test. Это выбранный вариант.

## Решение

Stage 2c добавляет immutable `AssemblyRenderIntent`, отдельный
`ASSEMBLE_HORIZONTAL` `PipelineJob` и immutable READY result. API атомарно
сохраняет intent, request identity, job и первую attempt; enqueue выполняется
после commit. Worker получает из BullMQ только versioned job reference, захватывает
lease и читает exact render plan из PostgreSQL.

Worker никогда не разрешает `AssemblyRecipe.currentRevision`. Единственным
входом является сохранённый `recipeRevisionId` вместе с captured cut/asset
snapshots. Более новая recipe revision не изменяет, не отменяет и не подменяет
уже созданный render intent.

Доменный/application код использует owned `AssemblyRenderer` и storage/dispatch
ports. FFmpeg, Prisma, BullMQ и object keys не протекают в domain DTO. Новый
service или queue не создаются.

## Durable entities и constraints

### `AssemblyRenderIntent`

Immutable поля:

- `id`, `projectId`, `sourceId`, `sourceVersion`;
- exact `cutPipelineJobId` и `cutResultArtifactId`;
- captured cut checksum, size и cut recipe version;
- `assemblyRecipeId`, exact `recipeRevisionId`, номер revision и configuration
  fingerprint;
- `renderContractVersion = horizontal-render-v1`;
- captured `audioProfileVersion` и `encodingProfileVersion`;
- `expectedDurationMs = intro + cut + advertisement + outro`;
- `createdAt`.

Уникальность `(recipeRevisionId, renderContractVersion)` означает один logical
render для одной exact recipe и implementation contract. Новая implementation
version может создать новый intent, не переписывая старый.

Composite foreign keys и checks связывают intent с тем же project,
source/version, cut job/artifact и exact recipe revision. `expectedDurationMs`
положителен и вычисляется только из captured duration snapshots.

### `AssemblyRenderRequest`

Хранит globally unique client `Idempotency-Key`, canonical request fingerprint,
resulting intent ID и timestamp. Тот же key с тем же fingerprint возвращает тот
же intent/job. Тот же key с другим body возвращает 409. Одновременные разные
keys для той же exact recipe сходятся на одном intent.

### `PipelineJob`

- новый type `ASSEMBLE_HORIZONTAL`;
- type-aware обязательный `assemblyRenderIntentId`, unique и non-null только
  для этого type;
- `payloadVersion = 1`, `recipeVersion = horizontal-render-v1`;
- project/source/version обязаны совпасть с intent;
- `totalMs = expectedDurationMs`, retry budget — два повтора после первой
  attempt;
- `JobAttempt(1, QUEUED)` создаётся в той же PostgreSQL transaction;
- montage asset, cut segment и cut request references для этого job отсутствуют.

Pipeline job idempotency key является server-owned deterministic identity
intent, а не вторым клиентским ключом.

### Result lineage

Добавляется `MediaArtifactRole.HORIZONTAL_ASSEMBLY_RESULT`. Один READY artifact
связан с exact render job через существующую unique job relation и хранит private
object key, checksum, size, content type, source lineage, render contract и
FFmpeg version.

`AssemblyRenderResult` связывает exact intent и artifact и хранит фактические:

- duration, width/height, FPS numerator/denominator;
- video codec и pixel format;
- audio codec, sample rate и channel count;
- FFmpeg/FFprobe versions;
- measured integrated loudness, true peak и normalization profile outcome;
- completion timestamp.

Object key не входит в public DTO или structured logs. Исторические intents,
results, recipes, cut results и assets не изменяются и не удаляются этим slice.

## REST v1 contract

- `POST /api/v1/pipeline-jobs/:cutJobId/assembly-renders`
  - обязательный `Idempotency-Key`;
  - body `{ "recipeRevision": 3 }`;
  - возвращает `202` с render и pipeline job identity.
- `GET /api/v1/assembly-renders/:renderId` возвращает persisted intent, job
  state/revision/progress, safe failure и READY result metadata.
- `GET /api/v1/projects/:projectId/assembly-renders?cursor=&limit=` восстанавливает
  состояние после reload без N+1 polling.
- `GET /api/v1/assembly-renders/:renderId/content` доступен только для READY,
  поддерживает bounded MP4 Range/206 и не раскрывает storage credentials.

При POST указанная revision должна существовать, принадлежать exact READY cut и
на момент admission быть current revision aggregate. Stale UI получает 409.
После успешного admission intent остаётся на этой exact revision.

Public response содержит exact recipe revision/fingerprint и input snapshots,
но не object keys, raw FFmpeg graph, CTA text в logs или внутренние storage
receipts. OpenAPI-generated client остаётся единственным frontend contract.

## Admission invariants

Одна serializable PostgreSQL transaction до любых external effects проверяет:

1. Target — exact `CUT_SEGMENT/READY` и exact `CUT_RESULT/READY`.
2. Project, source/version, checksums, sizes и recipe snapshots совпадают.
3. Exact recipe revision имеет поддерживаемые schema/profile versions.
4. Все montage assets READY, того же project/source version, правильного kind,
   и их revision/checksum/size/duration совпадают с captured references.
5. Source authorization и asset-scoped rights проходят текущую policy; local
   auto evidence не принимается после перехода к manual policy.
6. Expected duration и число inputs остаются в documented v1 limits.

Любое нарушение даёт controlled 4xx/409 и zero partial writes. Если policy или
lineage становятся непригодными после admission, worker/reconciler переводит job
в controlled `FAILED_FINAL`; он не оставляет её бесконечно `QUEUED`.

## Deterministic FFmpeg graph

`youtube-h264-v1` — server-owned profile без клиентских codec/filter knobs:

- exact cut задаёт output canvas и rational FPS после повторного FFprobe;
- каждый video input получает PTS reset, aspect-preserving scale, black pad до
  canvas, `setsar=1` и одинаковый FPS;
- cut-only banners и CTA применяются до split cut на точке рекламы;
- cut затем разбивается на `[0,t)` и `[t,D)`, а normalized streams concat-ятся в
  порядке intro, pre-cut, advertisement, post-cut, outro;
- без advertisement используется единый cut stream;
- video кодируется `libx264`, `veryfast`, CRF 20, `yuv420p`;
- audio кодируется AAC stereo, 48 kHz, 192 kbps;
- MP4 получает `+faststart`; volatile source metadata и creation timestamps
  удаляются.

Все paths генерируются worker и находятся в private scratch. Graph передаётся
через owned `filter_complex_script`; процесс запускается без shell. User input
не становится option name, path или raw filter expression. Contract гарантирует
один logical output, но не обещает bit-identical bytes между разными FFmpeg/CPU
versions; фактическая implementation и FFmpeg version входят в lineage.

### Banner rendering v1

- только ранее проверенные static JPEG/PNG/WebP;
- aspect-preserving scale в bounded area, без выхода за canvas;
- четыре recipe positions и server-owned safe margin;
- z-order детерминирован: banners по ordinal, CTA поверх них;
- interval использует cut-local `startMs <= t < endMs`;
- banner отсутствует на intro, advertisement и outro.

### CTA rendering v1

- pinned licensed font с version/checksum в worker image;
- белый текст на server-owned полупрозрачной тёмной плашке;
- deterministic wrapping максимум в две строки и bounded font size;
- UTF-8 text хранится во временном private text file и читается с отключённым
  expansion; текст не интерполируется в shell/filter arguments;
- interval и position имеют те же cut-local semantics, что banner.

Отсутствие required FFmpeg filters/font проверяется на startup/smoke и не ведёт
к silent fallback на другой layout.

## Two-pass audio normalization

`youtube-stereo-v1` нормализует целую assembled program, а не каждый segment
отдельно:

1. Все присутствующие tracks resample-ятся в stereo 48 kHz; для input без audio
   создаётся exact-duration stereo silence.
2. Первый FFmpeg pass выполняет только итоговый audio graph и EBU R128 loudness
   analysis, без video encode.
3. Второй pass применяет measured values к тому же canonical graph с целями
   `I=-14 LUFS`, `TP=-1.5 dBTP`, `LRA=11` и одновременно кодирует final video.
4. Полностью silent program получает корректную silent AAC track; loudness
   measurements остаются nullable и не подменяются фиктивными числами.

Malformed analysis JSON, non-finite values или output вне допустимого profile
заканчиваются controlled failure.

## Progress и observability

Для assembly job добавляется persisted attempt-scoped progress:

- `progressAttemptNumber`;
- `progressPhase`;
- `progressBasisPoints` в диапазоне 0..10000;
- monotonic pipeline job revision и timestamp.

Server-owned `assembly-progress-v1` делит работу на download, audio analysis,
encode, output probe/hash, upload и finalize. Download/hash/upload используют
реальные processed bytes; FFmpeg phases используют реальный `out_time` и exact
expected duration. Таймерные и симулированные проценты запрещены. Неизмеримая
короткая операция показывает phase без выдуманного движения.

Heartbeat обновляет progress только под active lease и никогда не уменьшает
basis points внутри одной attempt. Новая attempt имеет новый номер и начинает
с нуля; UI не смешивает её progress со старой attempt. Reload читает progress
из PostgreSQL. Structured telemetry фиксирует queue wait, phase durations,
bytes, output duration, peak scratch estimate, retry/failure code и worker ID,
но не CTA text, object keys или credentials.

## Retry, lease safety и cleanup

Retryable failures:

- transient PostgreSQL, object storage и network failures;
- worker shutdown, lease loss и bounded timeout;
- временная невозможность выполнить external storage operation.

Terminal failures:

- authorization/rights, exact lineage, checksum или size mismatch;
- unsupported schema/profile, missing input или invalid media decode;
- deterministic FFmpeg/filter failure после валидных inputs;
- malformed loudness result или invalid final output.

`PipelineJob.nextAttemptAt` хранит PostgreSQL-authoritative bounded exponential
backoff. Reconciler и targeted dispatch учитывают это поле. Retry budget не
принадлежит BullMQ; queue delivery имеет одну attempt и может быть восстановлена
после потери Redis.

Каждая worker attempt использует уникальный object key с job, attempt и lease
identity. До upload `JobAttempt.outputObjectKey` и cleanup intent сохраняются
под active lease. READY finalization атомарно:

- повторно проверяет lease и exact intent/input identity;
- создаёт один immutable result artifact/result;
- переводит job и attempt в READY;
- снимает cleanup intent только для принятого object.

Worker с потерянным lease не может финализировать result. Его объект удаляется
немедленно либо durable cleanup reconciler. При неоднозначном DB commit worker
сначала перечитывает authoritative result; удаление до reread запрещено.

## CPU, concurrency и resource admission

`ASSEMBLE_HORIZONTAL` и `CUT_SEGMENT` принадлежат одному configurable CPU-heavy
pool. Локальный default остаётся один slot; этот ADR не повышает concurrency.
FFmpeg threads ограничиваются deployment config исходя из CPU quota и числа
slots. Один render запускает один final video encode; unbounded per-input FFmpeg
fan-out запрещён.

До claim worker читает exact immutable resource plan и резервирует:

- bytes отсутствующих в local verified cache inputs;
- conservative estimated output bytes по duration/profile/input sizes;
- bounded temporary/filter/text data;
- configured scratch safety reserve.

Worker-local admission manager учитывает уже зарезервированные bytes. На
отдельных worker instances budget задаётся относительно их собственного scratch
volume/quota. Недостаток CPU slot или scratch не создаёт attempt и не расходует
retry budget: job остаётся `QUEUED`, получает safe `admissionReason` и bounded
`nextAttemptAt`. Освобождение reservation обязательно в `finally` после success,
failure, abort и lease loss.

Сначала сохраняется job, затем он может ждать ресурс: отсутствие свободного
slot не отклоняет операторский intent. Fair ordering использует существующие
priority/queuedAt и не позволяет assembly jobs обойти старые cut jobs без
отдельно утверждённой policy.

## Output validation и controlled failure

До upload worker проверяет final MP4 через FFprobe:

- один H.264 video stream, `yuv420p`, ожидаемые canvas/SAR/FPS;
- одна AAC stereo 48 kHz audio track, включая silent source;
- finite duration с допуском `max(250 ms, 2 frames)` от expected duration;
- отсутствие unsupported rotation/layout;
- non-empty size и полный SHA-256.

Advertisement boundary проверяется относительно `introDuration + insertAtMs` в
frame tolerance. Integration fixtures проверяют присутствие/отсутствие overlays
на кадрах до, внутри и после интервалов и их отсутствие во время advertisement.
Decode/corruption одного input даёт safe terminal failure и не повреждает cut,
asset, recipe или более ранний render.

## Безопасность

- Project/source-version authorization и asset-scoped rights проверяются при
  admission, dispatch, claim, finalization и private content read.
- Cross-project/source-version references fail closed.
- Все objects private; content идёт через bounded authorized Range endpoint.
- Raw FFmpeg arguments, remote URLs и arbitrary filters отсутствуют в API.
- FFmpeg запускается без shell с protocol allowlist и private scratch paths.
- CTA text не пишется в logs и не интерполируется в arguments.
- Object keys, credentials, storage receipts и internal errors не входят в DTO.
- Size, duration, pixel, input count, output estimate, timeout, threads и scratch
  имеют server-owned bounds.

## Стоимость и последствия

- Платные сервисы и новые runtime components не добавляются.
- Каждый новый recipe revision хранит максимум один assembled output для
  `horizontal-render-v1`.
- CPU cost: один полный video encode плюс audio-only analysis. Storage cost:
  один immutable MP4 и краткоживущие attempt objects до cleanup.
- API/OpenAPI, Prisma schema, worker discriminated job model, FFmpeg adapter,
  storage progress port и tests изменяются одним bounded backend/worker slice.
- Существующие source, cut, thumbnail, montage и recipe behavior не меняются.
- General progress/backoff fields увеличивают migration и test scope, но
  устраняют fake progress и tight retry loop и пригодны для будущих job types.

## Миграция и rollout

Только additive migration:

1. Добавить enums/nullable job fields, intent/request/result tables, composite
   FKs/checks/indexes и new artifact role; старые rows не переписывать, кроме
   безопасных defaults/nullable fields.
2. Сгенерировать Prisma/OpenAPI clients и пройти isolated PostgreSQL migration,
   contract, worker и existing regression tests.
3. Развернуть worker, который явно понимает `ASSEMBLE_HORIZONTAL`, при ещё
   выключенном API admission.
4. Проверить worker startup capabilities: FFmpeg filters, pinned font, storage,
   scratch и current concurrency.
5. Развернуть API и включить feature flag только после проверки нового worker.
6. Выполнить disposable short render, controlled corrupt-input test, затем один
   реальный 30-minute render.

Старый worker нельзя запускать после появления runnable new-type jobs: unknown
job types обязаны fail closed, а не попадать в cut branch.

## Rollback

1. Отключить создание новых assembly render intents/API route feature flag.
2. Drain либо controlled-finalize все `ASSEMBLE_HORIZONTAL` jobs.
3. Только после drain вернуть предыдущий worker/API.
4. Сохранить additive tables, intents, attempts, results и private objects для
   forward fix; не удалять пользовательские assets/cuts/recipes.
5. Existing upload, cutting, manual editorial, montage asset и recipe paths
   продолжают работать.

Physical cleanup или down migration с потерей lineage не входят в rollback.

## Критерии успеха

1. Exact recipe с intro, outro, advertisement, двумя banners и CTA создаёт один
   READY MP4 и восстанавливается после API/worker restart и browser reload.
2. Output duration совпадает с `I + D + A + O` в допуске
   `max(250 ms, 2 frames)`; advertisement начинается около
   `intro + insertAtMs`.
3. Banner/CTA присутствуют только в заданных cut-local intervals и отсутствуют
   на intro, advertisement и outro.
4. Output имеет H.264/yuv420p и AAC stereo/48 kHz. Для non-silent program
   integrated loudness равна `-14 +/- 1 LUFS`, true peak не выше `-1 dBTP`.
5. Same-key replay, concurrent different-key request, duplicate queue delivery,
   worker restart, expired lease и Redis loss сходятся на одном logical artifact
   без duplicate authoritative output.
6. Corrupt asset, checksum mismatch, unsupported profile, revoked authorization,
   timeout и storage failure дают ожидаемое terminal/retryable состояние без
   вечного QUEUED/PROCESSING и без orphan вне durable cleanup.
7. Progress после reload основан на реальных bytes/media time; внутри attempt он
   monotonic, retry явно начинает новую attempt.
8. Scratch reservations и FFmpeg process/thread counts не превышают config;
   admission denial не расходует retry budget.
9. Реальный 30-minute smoke на текущем локальном 2-CPU profile проходит без OOM
   и disk safety breach. MVP capacity gate: wall time не больше длительности
   результата (`RTF <= 1.0`), с записанными peak RSS, scratch, bytes и phase
   durations. Concurrency остаётся 1 до отдельного benchmark.
10. Existing source/cut/thumbnail/editorial/montage/recipe tests, migrations,
    OpenAPI drift, lint, typecheck, format, build и independent real-diff review
    проходят без регрессий.

## Out of scope

- final preview/approval UI и export package;
- связывание editorial metadata revision с approval;
- manual retry/cancel/pause commands;
- несколько advertisements, transitions, animated banners и arbitrary filters;
- custom fonts, positions, codec/bitrate knobs или remote asset URLs;
- external editor/render providers;
- AI metadata/thumbnail, Twitch ingestion, vertical clips;
- YouTube publishing, scheduling и analytics;
- автоматическое повышение worker concurrency или изменение Docker CPU/RAM.

## Решение tech lead

Approved. Independent review ADR-006 и CLEAN acceptance Stage 2b immutable
recipe slice получены; реализация Stage 2c авторизована в границах этого ADR.
Live deployment остаётся запрещён до CLEAN review реализации и выполнения
описанного rollout gate.
