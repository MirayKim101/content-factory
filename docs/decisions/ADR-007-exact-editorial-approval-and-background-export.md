# ADR-007: Exact editorial approval and background export package

- Статус: approved
- Дата: 2026-09-06
- Автор решения: Software Architect — ADR-007 Approval and Export
- Reviewer / approver: Independent architecture review — CLEAN (2026-09-06)
- Область: Stage 2d–2e, локальный горизонтальный editorial pipeline

## Проблема и доказательства

Stage 2 требует после фоновой горизонтальной сборки показать оператору единый
предпросмотр, подтвердить точную версию результата и получить видео, обложку и
текстовые metadata одним пакетом. Для каждого ролика также требуется измерять
время обработки, прямую стоимость и ручное внимание оператора.

Текущая модель уже содержит независимые immutable составляющие:

- `EditorialPackageRevision` с ручными title, description, ordered tags,
  processing template revision и private thumbnail;
- `AssemblyRecipeRevision` с exact cut/asset snapshots;
- `AssemblyRenderIntent` и READY `AssemblyRenderResult` с exact recipe revision,
  output artifact, checksums, media properties и нормализацией звука;
- `PipelineJob` и `JobAttempt` с authoritative queue/start/finish timestamps,
  attempts, retry и progress.

Новых редакторов metadata, thumbnail, montage assets, recipe или render не
нужно. Отсутствует контрольная точка, которая атомарно связывает exact editorial
revision и exact rendered artifact, доказывает ручную проверку, становится
неактуальной при последующей правке и служит единственным основанием для
экспорта.

Раздельные существующие download endpoints не образуют один переносимый пакет.
Сборка ZIP из большого MP4 внутри HTTP request или браузера нарушила бы запрет
на long-running work в API, создала бы риск buffering и потеряла бы durable
retry/recovery. Поэтому preview/approval и export разделяются на два
последовательных vertical slice, но используют один exact approval contract.

## Текущие ограничения

- Nuxt SPA и NestJS остаются независимыми за versioned REST/OpenAPI contract.
- PostgreSQL является authoritative state; Redis/BullMQ остаётся disposable
  delivery coordination.
- Long-running archive work не выполняется в HTTP request.
- Используются существующие `editorial-content`, media-worker, очередь и private
  S3-compatible object storage; новый service или queue не добавляется.
- Source authorization и montage asset rights применяются fail-closed по exact
  source version.
- Existing editorial, recipe, render и media artifacts immutable; approval и
  export не переписывают их.
- Stage 2 остаётся полностью ручным и локальным. AI, Twitch, vertical clips,
  publishing и analytics не входят в это решение.
- Mobile UX и автоматическое повышение worker concurrency не входят.

## Варианты

### Вариант A: сохранить текущие раздельные download и ручную отметку вне системы

Плюсы: нет migration, нового job type и дополнительного storage. Минусы: система
не знает, какие exact revisions были проверены, не снимает подтверждение после
правки, не измеряет operator attention и не выдаёт один пакет. Stage 2 не
завершён. Вариант остаётся функциональным admission-disabled режимом на
forward-compatible binaries, но не выбран как результат.

### Вариант B: формировать ZIP синхронно в NestJS

Плюсы: меньше durable entities. Минусы: многогигабайтный долгий HTTP request,
сложное восстановление после disconnect, API I/O и scratch contention, отсутствие
lease fencing и durable cleanup. Противоречит architecture baseline и отклонён.

### Вариант C: формировать ZIP в браузере

Плюсы: backend не выполняет archive job. Минусы: браузер повторно скачивает все
private inputs, может буферизовать гигабайты, не имеет authoritative recovery и
создаёт различающиеся результаты между clients. Отклонён.

### Вариант D: exact approval и background streaming ZIP64 в existing worker

Плюсы: использует существующие job leases, retry, reconciliation, object storage
и OpenAPI boundaries; не требует платного сервиса; не перекодирует video; позже
job type можно выделить в отдельный bounded pool без изменения product contract.
Минусы: нужны additive persistence, новый job branch, streaming ZIP adapter и
ещё один immutable object размером примерно с готовое видео. Это выбранный
вариант.

## Решение

Реализация выполняется двумя vertical slice:

1. **Stage 2d — exact preview, manual approval and per-video metrics.** API
   формирует согласованный review candidate из current editorial revision и
   READY assembly render exact current recipe revision. Оператор подтверждает
   одну exact комбинацию. Worker не меняется.
2. **Stage 2e — background export package.** Только current approval допускается
   к durable export intent/job. Existing worker потоково формирует private ZIP64,
   сохраняет immutable result и отдаёт его через authorized Range endpoint.

Approval и export принадлежат существующему `editorial-content`. Domain и
application code используют owned repository/exporter/storage ports; Prisma,
BullMQ, ZIP implementation и object keys не протекают в domain DTO.

## Stage 2d: review candidate и exact approval

### Review candidate

`GET /api/v1/pipeline-jobs/:cutJobId/editorial-review` возвращает один
authoritative read model:

- exact cut/source lineage;
- current `EditorialPackageRevision`, её validation и private thumbnail content
  URL;
- current `AssemblyRecipeRevision` identity/fingerprint;
- READY `AssemblyRenderIntent`/result для exact current recipe revision и
  private video content URL;
- stable `candidateFingerprint` из всех значимых exact identities;
- blockers, current/historical approval и provisional processing metrics.

Frontend не склеивает candidate из независимо устаревающих cached responses.
Read model может использовать существующие repositories внутри одного owned
module transaction/read boundary, но не раскрывает object keys.

Candidate считается approvable только когда:

1. target является exact `CUT_SEGMENT/READY` с READY cut artifact;
2. editorial package существует, current revision полна, выбранная thumbnail
   READY и принадлежит тому же project;
3. assembly recipe существует, а render result READY и создан именно из её
   current revision;
4. project, source/version, cut job/artifacts, recipe/render и thumbnail lineage
   согласованы;
5. source authorization и все captured montage rights проходят текущую policy;
6. approval/render/profile contracts поддерживаются.

Отсутствующая или incomplete часть возвращается как safe blocker, а не как
частично approvable candidate.

### Durable approval

Добавляется immutable `EditorialApproval` со следующими snapshots:

- `id`, `projectId`, `sourceId`, `sourceVersion`, `cutPipelineJobId`;
- `editorialPackageId`, exact `editorialPackageRevisionId` и revision number;
- exact `processingTemplateRevisionId`;
- exact `thumbnailAssetId`, checksum, size и content type;
- `assemblyRecipeId`, exact `recipeRevisionId`, revision number и configuration
  fingerprint;
- exact `assemblyRenderIntentId`, `assemblyRenderResultId` и render artifact ID,
  checksum, size и contract version;
- `approvalContractVersion = manual-horizontal-approval-v1`;
- `candidateFingerprint`, `approvedAt` и immutable metrics snapshot.

Title, description и ordered tags остаются в immutable
`EditorialPackageRevision`; approval не дублирует их как mutable columns.
Snapshot identities позволяют восстановить исторический preview и собрать
точный export после reload.

Обе операции используют единый durable `EditorialOperationRequest` ledger с
database-unique client `Idempotency-Key`, operation discriminator, полным
canonical request tuple/fingerprint, resolved project ID и type-aware resulting
approval/export intent reference. Две независимые request tables без общего
unique constraint не считаются глобальной idempotency. Для approval canonical
tuple фиксирован как:

```text
operation = CREATE_EDITORIAL_APPROVAL
approvalContractVersion
path.renderId
resolved.projectId
resolved.sourceId
resolved.sourceVersion
resolved.cutPipelineJobId
resolved.editorialPackageId
resolved.editorialPackageRevisionId
resolved.assemblyRecipeId
resolved.recipeRevisionId
resolved.assemblyRenderResultId
resolved.thumbnailAssetId
body.editorialRevision
body.candidateFingerprint
body.manualAttentionMs
body.attentionMeasurementVersion
```

Canonical serialization использует versioned fixed field order, UTF-8, decimal
integers и explicit values без зависимости от JSON property order. Path target
является частью identity, а не только lookup parameter. Тот же key с другим
`renderId`, project/source lineage, revision, attention value или любым другим
элементом tuple всегда даёт `409`.

Ledger имеет type-aware database checks: approval operation ссылается ровно на
resulting approval, export operation — ровно на export intent; другая result
relation должна быть null. Тот же key в другой operation также является другим
canonical tuple и даёт `409`.

Replay выполняется только после повторного разрешения path target и проверки,
что сохранённый `resolved.projectId` совпадает с project текущего запроса.
Cross-project request никогда не получает сохранённый response, даже если знает
чужой key. Уникальность exact editorial revision, render intent и approval
contract означает один logical approval для одной exact комбинации. Same
key/same canonical tuple возвращает тот же approval; concurrent different keys
сходятся на одном logical approval.

`POST /api/v1/assembly-renders/:renderId/editorial-approvals` принимает:

```json
{
  "editorialRevision": 3,
  "candidateFingerprint": "sha256:...",
  "manualAttentionMs": 245000,
  "attentionMeasurementVersion": "foreground-preview-v1"
}
```

Approval создаётся в serializable PostgreSQL transaction после повторной
проверки всех candidate invariants и exact current revisions. Никаких external
effects до commit нет.

`GET /api/v1/projects/:projectId/editorial-approvals?cursor=&limit=` и review
read model восстанавливают approval/history без N+1 запросов.

### Derived staleness и invalidation

Approval остаётся immutable. Его public state вычисляется как `CURRENT` или
`STALE`; mutation hooks в существующие save recipe/save metadata use cases не
добавляются.

Approval является `CURRENT`, только если одновременно:

- `EditorialPackage.currentRevision` равна captured editorial revision;
- `AssemblyRecipe.currentRevision` равна captured recipe revision;
- captured render result/artifact остаётся READY и exact;
- selected thumbnail остаётся READY и exact;
- source authorization и captured montage rights применимы по current policy;
- approval/render contracts поддерживаются.

Иначе API возвращает `STALE` и safe reason codes, например
`EDITORIAL_REVISION_CHANGED`, `ASSEMBLY_RECIPE_REVISION_CHANGED`,
`AUTHORIZATION_REQUIRED`, `ASSET_RIGHTS_REQUIRED` или
`APPROVAL_CONTRACT_UNSUPPORTED`.

Новая metadata revision, в том числе будущая AI generation/edit, автоматически
снимает current approval. Новая recipe revision делает то же. Простая загрузка
невыбранной thumbnail или montage asset ничего не инвалидирует. Исторический
approval не удаляется и не переписывается.

Export admission, worker claim/finalization и current package download повторно
вычисляют staleness. Поэтому race «approval проверен, затем metadata изменена» не
может выдать актуальный export из устаревшей комбинации.

### Processing, cost и manual-attention metrics

`EditorialApproval` имеет immutable one-to-one metrics snapshot с
`metricsSchemaVersion = approval-metrics-v1` и
`timestampBasisVersion = persisted-job-attempt-v1`. Для cut и assembly jobs
отдельно сохраняются:

- `initialQueueWaitMs`;
- `retryWaitMs`;
- `firstStartToFinishMs`;
- `activeAttemptMs`;
- `attemptCount` и `retryCount`.

Общий snapshot содержит `cutToAssemblyReadyElapsedMs`, output duration/bytes,
`manualAttentionMs`, `attentionMeasurementVersion`,
`directProviderCostMinor`, `costCurrency`, `costBasisVersion` и массив
`incompleteReasons`.

Формулы `approval-metrics-v1` фиксированы:

```text
firstStartedAt = min(JobAttempt.startedAt where startedAt is not null)
initialQueueWaitMs = firstStartedAt - PipelineJob.queuedAt
retryWaitMs = sum(attempt[N].startedAt - attempt[N-1].finishedAt), N > 1
firstStartToFinishMs = PipelineJob.finishedAt - firstStartedAt
activeAttemptMs = sum(attempt.finishedAt - attempt.startedAt)
attemptCount = count(attempt where startedAt is not null)
retryCount = max(attemptCount - 1, 0)
cutToAssemblyReadyElapsedMs = assemblyJob.finishedAt - cutJob.queuedAt
```

Attempts сортируются по `attemptNumber`; gap учитывается в `retryWaitMs` только
когда предыдущий `finishedAt` и следующий `startedAt` присутствуют. Время
ожидания до первой попытки не смешивается с retry wait, active work не включает
queue/retry gaps, а `firstStartToFinishMs` намеренно включает retry gaps после
первого старта. `cutToAssemblyReadyElapsedMs` — календарное время pipeline,
которое может включать ручную паузу между cut и assembly; UI не называет его CPU
time.

`persisted-job-attempt-v1` использует существующие persisted UTC значения
`PipelineJob`/`JobAttempt` независимо от того, какой writer — API, worker или
recovery/reconciler — их сохранил. Контракт не утверждает, что все writers
использовали один PostgreSQL clock, и не корректирует timestamps по local
worker/browser time. Расчёт использует целые epoch milliseconds после
database/driver precision conversion; browser wall clock в processing formulas
не участвует.

Отсутствующая граница, non-terminal attempt или отрицательная разность даёт
`null` только для зависимой метрики и versioned safe reason, например
`TIMESTAMP_MISSING`, `TIMESTAMP_ORDER_INVALID` или
`TIMESTAMP_CLOCK_SKEW_SUSPECTED`, с указанием затронутого cut/assembly field.
Значение не превращается в `0`, не clamp-ится и не переставляется задним числом.
Approval новых Stage 2 READY jobs требует полных cut/assembly timestamps;
nullable policy нужна для truthful controlled чтения legacy, recovery-written
или tampered data.

Stage 2d не переписывает historical job/attempt rows и не меняет worker timestamp
writers или recovery lifecycle. Metrics query и snapshot только читают и
валидируют существующие persisted values в API-owned transaction.

Queue/processing values вычисляются только из PostgreSQL `PipelineJob` и
`JobAttempt` timestamps в approval transaction. Worker phase logs остаются
observability evidence, но не являются единственным источником approval metrics.

Для полностью локального Stage 2 `directProviderCostMinor = 0`, currency `RUB`,
а `costBasisVersion = local-direct-provider-cost-v1`. UI обязан явно писать, что
это нулевые прямые платные provider/API расходы, а не оценка электричества,
амортизации компьютера или труда. Raw compute time и output bytes сохраняются,
чтобы позднее применить утверждённый rate card без выдумывания текущей цены.

Frontend timer `foreground-preview-v1` считает только время открытого видимого
review UI, останавливается при hidden/close и сохраняет unapproved draft,
привязанный к exact `candidateFingerprint`. Draft timer не является business
approval state. При нажатии approve значение и idempotency identity замораживаются;
после успешного commit PostgreSQL snapshot становится authoritative. Invalid,
negative, non-integer или превышающий восемь часов value отклоняется.

## Stage 2e: background ZIP64 export

### Durable entities и job

Добавляются:

- immutable `EditorialExportIntent` для exact `EditorialApproval` и
  `exportContractVersion = editorial-export-zip-v1`;
- export operation row в общем `EditorialOperationRequest` ledger с globally
  unique client idempotency key, полным canonical request tuple/fingerprint,
  resolved project ID и resulting intent;
- отдельный `EXPORT_EDITORIAL_PACKAGE` `PipelineJob` с exact project/source
  lineage и one-to-one export intent;
- `MediaArtifactRole.EDITORIAL_EXPORT_PACKAGE`;
- immutable `EditorialExportResult`, связывающий intent, pipeline job и READY
  ZIP artifact с checksum, size, filename, entry manifest и completion time.

Уникальность `(approvalId, exportContractVersion)` означает один logical export
для одного exact approval/contract. Canonical client request tuple фиксирован
как:

```text
operation = CREATE_EDITORIAL_EXPORT
exportContractVersion
path.approvalId
resolved.projectId
resolved.sourceId
resolved.sourceVersion
resolved.cutPipelineJobId
resolved.approvalCandidateFingerprint
resolved.editorialPackageRevisionId
resolved.recipeRevisionId
resolved.assemblyRenderResultId
```

Тот же key с другим `approvalId` либо resolved lineage даёт `409`. Replay
сначала повторно авторизует path approval и сравнивает saved/current project;
cross-project replay никогда не возвращает intent. Server-owned job idempotency
key имеет отдельный canonical tuple
`(DISPATCH_EDITORIAL_EXPORT, exportContractVersion, exportIntentId, projectId)`
и не заменяет client request key. Job и первая queued attempt создаются атомарно
с intent; enqueue выполняется только после commit.

### REST v1 contract

- `POST /api/v1/editorial-approvals/:approvalId/exports` с обязательным
  `Idempotency-Key` возвращает `202` и persisted intent/job state;
- `GET /api/v1/editorial-exports/:exportId` возвращает state, attempt-scoped real
  progress, safe failure, exact approval identity и READY result metadata;
- `GET /api/v1/projects/:projectId/editorial-exports?cursor=&limit=`
  восстанавливает status после reload;
- `GET /api/v1/editorial-exports/:exportId/content` отдаёт только current
  authorized READY package, поддерживает bounded single Range/206 и attachment
  filename без storage credentials.

Stale approval даёт controlled `409` до partial writes. Если approval становится
stale после admission, worker или reconciler переводит job в controlled
`FAILED_FINAL`; он не экспортирует устаревшую комбинацию.

### Package contract

ZIP64 содержит ровно server-owned root entry names:

```text
video.mp4
thumbnail.jpg | thumbnail.png | thumbnail.webp
metadata.txt
metadata.json
manifest.json
```

Никакое пользовательское значение не используется как entry path. Original
filename и title допускаются только как JSON/text content после UTF-8 encoding,
не как archive path.

`metadata.txt` — человекочитаемые UTF-8 title, description и ordered tags.
`metadata.json` содержит те же exact values в versioned machine-readable schema.
`manifest.json` с `manifestSchemaVersion = editorial-export-manifest-v1`
содержит export/approval contract versions, exact IDs/revisions и payload entry
descriptors. Checksum scope фиксирован как SHA-256 и uncompressed byte length
ровно четырёх payload entries:

- `video.mp4`;
- выбранной `thumbnail.*`;
- generated `metadata.txt`;
- generated `metadata.json`.

`manifest.json` намеренно не содержит checksum/size самого себя: self-hash не
имеет конечного canonical значения. Он также не содержит checksum/size outer
ZIP, потому что ZIP создаётся только после сериализации manifest. Outer ZIP
size/SHA-256 хранятся только в `EditorialExportResult`/artifact и public result
DTO. Manifest не содержит object keys, credentials, internal storage receipts
или raw authorization evidence.

Serialization frozen contract:

- metadata strings берутся без смыслового преобразования из exact immutable
  editorial revision; JSON escaping выполняется по JSON/UTF-8;
- `metadata.json` и `manifest.json` имеют fixed property order, compact JSON,
  UTF-8 без BOM и ровно один trailing LF;
- `metadata.txt` имеет fixed section order `TITLE`, `DESCRIPTION`, `TAGS`, LF
  line endings, UTF-8 без BOM и ровно один trailing LF;
- tags сохраняют exact stored order;
- entry checksum считается по exact uncompressed bytes, которые переданы ZIP
  writer, а не по compressed record или source object metadata.

Entry ordering, timestamps, permissions и line endings задаются contract, чтобы
retry одного implementation version не менял bytes из-за локального времени.
MP4 и thumbnail уже сжаты и записываются методом STORE без перекодирования и
бесполезного recompression. ZIP64 обязателен для inputs/archives больше 4 GiB.

### Streaming и resource admission

Owned `PackageExporter` получает streams через worker storage port и пишет один
archive file в private attempt scratch. Полные video/image buffers запрещены.
На чтении каждого input потоково проверяются exact byte count и SHA-256. После
закрытия central directory весь ZIP также получает exact size/SHA-256 и только
затем загружается как attempt-scoped private object.

Streaming inputs напрямую в archive означает, что scratch reservation покрывает
predicted archive size, bounded ZIP metadata и configured safety reserve, а не
одновременно полные локальные copies всех inputs плюс archive. Перед claim
worker делает admission; недостаток scratch оставляет job `QUEUED`, сохраняет
safe reason/`nextAttemptAt` и не расходует retry budget. Reservation освобождается
в `finally` после success, failure, abort и lease loss.

### Hard-crash scratch recovery

`finally` не выполняется при `SIGKILL`, process crash или machine loss, поэтому
in-memory reservation и обычного cleanup недостаточно. Каждая export attempt до
первой записи создаёт directory только под owned export prefix с identity:

```text
jobId + attemptNumber + non-secret lease identity hash
```

Directory и marker имеют mode `0700`. Marker хранит version, job ID, attempt,
lease identity hash, created time и reserved bytes, но не raw lease token,
credentials или object keys. Retry никогда не переиспользует directory старой
attempt.

Перед началом queue consumption и затем периодически worker выполняет scoped
scratch reconciliation:

1. сканирует только exact owned export prefix; unknown/malformed directories
   логирует и не удаляет автоматически;
2. читает PostgreSQL active job/attempt lease identity, owner и expiry для всех
   найденных markers, а не только для текущего worker ID;
3. directory с matching unexpired active lease любого worker сохраняет без
   изменений — один worker никогда не удаляет live scratch другого;
4. recognized directory удаляется только когда PostgreSQL подтверждает, что
   exact lease больше не active, и прошёл safety grace не меньше lease horizon;
5. ambiguous/unavailable PostgreSQL означает keep-and-retry-later, не delete;
6. cleanup failure сохраняется как structured safe evidence и учитывается
   admission до успешного удаления.

Reservation identity/bytes сохраняются под lease в `JobAttempt` либо отдельной
owned durable reservation record до начала записи. На startup worker
перестраивает local admission accounting из recognized directory allocated
bytes и PostgreSQL active reservations на том же scratch volume. Пока orphan
подтверждён, но ещё не удалён, его actual allocated bytes также считаются
занятыми. После reconciliation текущая statfs availability остаётся последним
physical safety gate. In-memory counter используется только как ускоряющая
projection и не может после restart считать scratch пустым без scan/rebuild.

Если crash произошёл после закрытия ZIP central directory, но до upload, archive
не считается result: новая attempt использует новый directory, а старый
удаляется только по правилам lease/grace выше. Если crash произошёл во время или
после upload, attempt-scoped object обрабатывается durable output cleanup/reread
правилами ниже; local scratch и remote object имеют независимые cleanup intents.

Existing worker/queue используются с текущим bounded concurrency. Export не
увеличивает local concurrency и не запускает FFmpeg. На локальном Stage 2
archive job может занимать один worker slot; отдельный I/O pool остаётся scale
optimization Stage 3 после измерений, а job contract уже позволяет такой
rollout без изменения product API.

Если ZIP adapter потребует новую runtime dependency, implementer до установки
проверяет official documentation, current supported version, ZIP64 streaming
semantics и security advisories, фиксирует exact version и lockfile и проводит
реальный >4 GiB sparse/disposable compatibility test. Dependency не выбирается
или не устанавливается этим ADR.

### Progress и observability

Pipeline progress type обобщается на source-code уровне без destructive rename
существующего PostgreSQL enum; migration только добавляет необходимые export
phase values. Public export phases versioned отдельно, например:

- `READ_INPUTS` / `WRITE_ARCHIVE`;
- `OUTPUT_HASH`;
- `UPLOAD`;
- `FINALIZE`.

Progress основан на реально прочитанных input bytes, записанных archive bytes,
hashed archive bytes и uploaded bytes. Таймерный или симулированный процент
запрещён. Progress monotonic только внутри exact attempt; retry показывает новый
attempt и начинает его шкалу заново. Reload читает progress из PostgreSQL.

Structured telemetry содержит queue wait, phase duration, bytes, scratch
reservation/peak, retry/failure code, worker ID и export contract version. Она
не содержит title, description, tags, object keys, credentials или archive
content.

### Retry, lease safety и cleanup

Transient PostgreSQL/object-storage/network failures, worker shutdown, lease
loss и bounded timeout retryable в пределах PostgreSQL retry budget и
`nextAttemptAt`. Stale approval, revoked authorization/rights, unsupported
contract, missing/tampered input, checksum/size mismatch и malformed archive
terminal.

Каждая attempt пишет уникальный object key из job/attempt/lease identity. До
upload worker сохраняет output key и durable cleanup intent под active lease.
READY finalization повторно проверяет active lease, exact approval/currentness,
input identities и result identity, затем атомарно создаёт один artifact/result,
переводит job/attempt в READY и снимает cleanup intent только для принятого
object.

Worker с потерянным lease не финализирует result. Его object удаляется сразу или
durable cleanup reconciler. После неоднозначного DB commit worker сначала
перечитывает authoritative result и только затем решает cleanup. Redis loss
восстанавливается existing PostgreSQL reconciler; duplicate delivery является
no-op после authoritative reread.

## Безопасность и авторизация

- Exact project/source-version authorization и captured montage asset rights
  проверяются при preview, approval, export admission, claim, finalization и
  content read.
- Cross-project, wrong-cut, wrong-thumbnail, wrong-recipe и wrong-render
  references fail closed.
- Все media/thumbnail/export objects private; public DTO не содержит object keys
  или storage credentials.
- Export content endpoint использует existing bounded Range semantics и
  `Content-Disposition` с безопасным fallback и RFC-compatible UTF-8 filename.
- Archive entry names полностью server-owned; path traversal, absolute paths,
  symlinks и arbitrary permissions отсутствуют.
- Metadata не пишется в logs. Manifest не содержит private paths, tokens,
  declaration text или internal errors.
- Input/output counts, bytes, manual attention, timeout, scratch and archive
  overhead имеют server-owned bounds.
- Approval является evidence редакционного review, но не заменяет source rights
  evidence и не даёт дополнительных storage permissions.

## Данные, стоимость и последствия

- Миграции только additive: approval/metrics, общий idempotent operation ledger,
  export intent/result, новый job type/artifact role/FK/checks/indexes и новые
  progress phase values. Existing rows и objects не переписываются.
- PostgreSQL хранит identities, metrics и metadata, но не большие archive bytes.
- На один current export permanent storage растёт примерно на размер assembled
  MP4 плюс thumbnail и малый metadata overhead. ZIP STORE не создаёт значимой
  CPU compression cost.
- Scratch peak ограничивается одним archive и safety reserve благодаря streaming
  inputs; network/object-storage read и write примерно равны размеру package.
- Платные API, новый service, queue, database или external editor не добавляются.
- Direct provider cost Stage 2 равен нулю по versioned narrow cost basis;
  electricity/hardware/labor не маскируются нулём.
- Immutable historical approvals/exports увеличивают storage. Retention или
  physical deletion требуют отдельной policy и не входят в Stage 2.

## Ownership и последовательность реализации

### Stage 2d

1. Один Backend Engineer владеет additive Prisma migration/schema/generated
   Prisma, `apps/api/src/editorial-content/**`, backend tests и generated
   OpenAPI artifacts.
2. После freeze/approval REST contract один Frontend Engineer владеет новым
   `features/review-editorial-package/**`, approval entity/API adapter/tests и
   минимальным entry point в horizontal/assembly result UI.
3. Existing manual editorial form и assembly recipe editor получают только
   минимальную query invalidation integration с обоснованным test.
   `apps/worker/**`, worker timestamp writers и recovery lifecycle в Stage 2d не
   меняются; recovery-written metrics fixture создаётся seed/fake repository в
   API tests.
4. Independent reviewer проверяет настоящий diff и воспроизводит concurrency,
   stale revision, reload, authorization и metrics cases.

### Stage 2e

1. Один Backend Engineer владеет additive export migration/API, worker
   discriminated job branch, owned streaming exporter/storage port, generated
   contracts и API/worker tests.
2. После freeze contract один Frontend Engineer владеет
   `features/export-editorial-package/**`, export status/progress/download UI,
   adapter и tests.
3. Ни один другой agent одновременно не меняет Prisma schema, generated
   contracts, worker job union, shared lockfile или эти feature directories.
4. QA проектирует recovery/lease/cleanup/large-archive acceptance; independent
   reviewer воспроизводит real diff evidence.

## Миграция и rollout

### Stage 2d rollout

1. Добавить approval schema/API behind disabled admission flag.
2. Пройти isolated PostgreSQL migration, unit/integration/race/OpenAPI checks.
3. Применить additive migration только после read-only проверки active jobs и
   backup/rollback evidence.
4. Развернуть API, включить preview, затем approval admission.
5. Выполнить short real preview/approval/reload/staleness smoke.

### Stage 2e rollout

1. Добавить export schema/job/artifact/progress values и generated contracts.
2. Пройти isolated migration, worker duplicate/restart/Redis-loss/lease/cleanup
   tests и real streaming ZIP/ZIP64 compatibility smoke.
3. При выключенном API export admission сначала развернуть worker, который явно
   понимает `EXPORT_EDITORIAL_PACKAGE`.
4. Проверить startup capabilities, private storage, scratch reservation и
   current concurrency.
5. Развернуть API/frontend и только затем включить export admission.
6. Выполнить disposable short export, controlled tampered-input failure, затем
   один real approved 30-minute Stage 2 package.

Rollout обязан создать и сохранить forward-compatible `admission-off` binaries:
они используют migrated Prisma enum/schema и понимают approval/export rows и
`EXPORT_EDITORIAL_PACKAGE`, но не принимают новые approval/export requests.
Этот build является rollback target. Pre-migration worker нельзя возвращать,
пока существуют runnable export jobs; unknown job types обязаны fail closed, а
не попадать в cut/render branch.

## Rollback

1. Отключить создание новых export intents и approval admission; оставить
   read-only historical state доступным только там, где authorization проходит.
2. Drain либо controlled-finalize все `EXPORT_EDITORIAL_PACKAGE` jobs.
3. Развернуть только сохранённые forward-compatible `admission-off` API/worker
   binaries, которые используют migrated enum/schema и явно игнорируют или
   читают terminal approval/export rows без ошибочного dispatch.
4. До rollout пройти automated rollback compatibility test: запустить эти
   binaries против migrated disposable PostgreSQL с terminal approval/export
   rows и всеми новыми enum values; доказать startup, reconciliation и прежние
   source/cut/editorial/montage/recipe/render paths.
5. Pre-migration binaries не являются допустимым rollback target. Их можно
   рассматривать только после отдельного доказательства enum/schema
   compatibility, полного отсутствия runnable new-type jobs и explicit
   architecture approval; drain сам по себе недостаточен.
6. Сохранить additive tables, approvals, metrics, attempts, export results и
   private objects для forward fix; не удалять user media.
7. Existing upload, cutting, manual editorial, montage assets, recipes,
   assembly renders и их downloads продолжают работать.

Down migration или physical cleanup с потерей lineage не входят в rollback.

## Измеримые критерии успеха Stage 2d

1. Один READY assembly render, complete manual metadata и READY thumbnail
   отображаются в одном preview после full browser reload.
2. Approval фиксирует exact editorial/template/thumbnail, recipe/render/artifact
   identities и не создаёт FFmpeg, storage object или pipeline job.
3. Same-key/same full canonical tuple replay, concurrent different-key request и
   ambiguous DB result сходятся на одном logical approval. Тот же key с другим
   path `renderId`, project/source lineage, revision, candidate fingerprint или
   attention value даёт controlled `409`; cross-project replay не раскрывает
   сохранённый approval.
4. Новая metadata revision и новая recipe revision по отдельности немедленно
   переводят approval в `STALE`; исторические data не меняются. Новый approval
   возможен только после READY render current recipe revision.
5. Cross-project lineage, incomplete metadata, wrong/non-READY thumbnail/render,
   tampered checksum, revoked source authorization и unusable montage rights
   fail closed.
6. Processing metrics совпадают с формулами `approval-metrics-v1`; queue, retry
   wait, active attempt, first-start-to-finish и calendar E2E не смешиваются.
   Fixture с `queued=00:00`, attempt 1 `00:10–00:40`, attempt 2
   `01:00–01:50` даёт initial queue `10s`, retry wait `20s`, active attempt
   `80s`, first-start-to-finish `100s`, attempts `2`, retries `1`. Missing либо
   invalid timestamp даёт `null` + reason, не zero/clamp. Отдельная пара с cut
   `queued=00:00` и assembly `finished=03:00` даёт calendar E2E `180s`.
   Manual attention после approval сохраняется и reload возвращает то же integer
   value/version.
7. UI явно показывает current/stale status, blocker reason, direct provider cost
   basis и то, что local hardware/electricity не оценены.
8. Public DTO/logs не раскрывают content text в telemetry, object keys или
   credentials. Existing source/cut/editorial/montage/recipe/render checks
   проходят.
9. Idempotency contract tests используют одинаковый key для двух разных
   `renderId` и для path из другого project и подтверждают `409`/non-disclosure,
   а не replay первого response.
10. Recovery-written timestamp fixture с `queued=00:00`, attempt 1
    `00:10–00:40`, attempt 2 `started=00:35`, `finished=00:34` и job
    `finished=00:50` сохраняется без rewrite. Он возвращает valid initial queue
    `10s`, first-start-to-finish `40s`, attempts `2`, retries `1`, но
    `retryWaitMs=null` и `activeAttemptMs=null` с field-specific
    order/clock-skew reasons. API не исправляет, не сортирует по wall time и не
    clamp-ит отрицательные интервалы.

## Измеримые критерии успеха Stage 2e

1. Current approval создаёт один background export, который после worker/API
   restart и browser reload становится READY и скачивается одним ZIP.
2. Archive содержит ровно пять contract entries. Manifest checksum scope
   включает exact uncompressed bytes video, thumbnail, generated metadata.txt и
   metadata.json; исключает manifest self и outer ZIP. Outer ZIP size/SHA
   присутствуют только в result/artifact DTO. Повторная serialization exact
   inputs даёт те же metadata/manifest bytes, entry order и ZIP bytes для одной
   implementation version.
3. Реальный approved 30-minute result экспортируется без full-file buffering,
   OOM и scratch safety breach; peak scratch, bytes, queue/phase durations и
   wall time записаны.
4. Disposable >4 GiB sparse/streaming fixture подтверждает ZIP64 reader
   compatibility без хранения fixture в repository или permanent object storage.
5. Same-key/same full canonical tuple replay, concurrent different-key request,
   duplicate queue delivery, Redis loss, worker restart и expired lease создают
   один logical READY artifact. Тот же key с другим path `approvalId` или project
   даёт `409` и не раскрывает чужой intent; reuse approval key для export также
   даёт `409` через общий operation ledger.
6. Staleness после admission, revoked rights, missing/tampered input, storage
   timeout/failure и insufficient scratch дают предусмотренные terminal/retry/
   queued states без вечного PROCESSING и без orphan вне durable cleanup.
7. Attempt progress после reload основан на real bytes, monotonic внутри attempt,
   и новый retry не смешивается с предыдущим attempt.
8. READY current package поддерживает Range/206 и безопасный attachment;
   historical stale artifact сохраняется, но current download/export gate его не
   предлагает как готовый к публикации.
9. Full Stage 2 smoke проходит путь: authorized source → cut → recipe with
   intro/outro/ad/two banners/CTA → normalized assembly → manual metadata and
   thumbnail → preview → approval → ZIP download and checksum verification.
10. Prisma validate/migration, OpenAPI drift, formatting/lint, TypeScript,
    unit/integration/recovery tests, build, controlled failure, documentation и
    independent real-diff review проходят без регрессий.
11. Hard-crash test убивает worker после закрытия ZIP central directory, но до
    upload; restart scan сохраняет directory любой ещё active lease, после
    expiry/grace удаляет orphan, восстанавливает admission accounting и новая
    attempt создаёт один READY artifact без reuse старого directory.
12. Rollback compatibility test запускает сохранённые forward-compatible
    `admission-off` binaries против migrated DB с terminal new-type rows/enum
    values. Pre-migration binary не считается rollback evidence без отдельного
    доказательства и approval.

## Explicit out of scope

- AI research, transcript, representative frames, text/image generation,
  provider/model/prompt provenance и AI cost limits (Stage 2B);
- creator profiles и likeness/reference-photo workflow (Stage 2B);
- Twitch ingestion, vertical clips, resumable multipart VOD upload (Stage 3);
- YouTube/TikTok publishing, scheduling, channels and analytics (Stage 3);
- mobile UX, public registration, multi-tenancy and application authentication;
- archive deletion/retention UI, bulk export, cancel/pause/manual retry;
- new worker service/queue, automatic concurrency increase or VDS sizing.

## Решение tech lead

Approved. Stage 2d exact preview, approval and metrics implementation
авторизован первым в границах этого ADR и отдельного task brief. Stage 2e
background export implementation разрешается только после independent CLEAN
review и acceptance Stage 2d.

Live migrations, runtime deployment и включение admission для каждого slice
остаются запрещены до independent CLEAN review соответствующей реализации и
выполнения описанного rollout gate.
