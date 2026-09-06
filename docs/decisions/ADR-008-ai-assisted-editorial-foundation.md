# ADR-008: AI-assisted editorial foundation with exact provenance

- Статус: accepted
- Дата: 2026-09-06
- Автор решения: Solution Architect — AI-Assisted Editorial Foundation
- Reviewer / approver: Independent architecture review — CLEAN (2026-09-06)
- Область: Stage 2B, локальный horizontal editorial pipeline до Twitch

## Проблема и доказательства

Stage 2 уже создаёт immutable horizontal render, ручные metadata/thumbnail,
exact approval и детерминированный ZIP export. Stage 2B должен ускорить
подготовку title, description, tags и thumbnail, но не заменять этот проверенный
ручной путь и не ослаблять exact approval из ADR-007.

Одного имени стримера недостаточно для безопасной генерации. Оно не доказывает
актуальный контекст, официальный профиль или право использовать реалистичное
изображение человека. Web-результат, transcript и кадры также нельзя считать
взаимозаменяемыми: у них разные источники, freshness, права, стоимость и exact
lineage. Прямое сохранение ответа конкретного provider в текущую editorial
revision сделало бы результат невоспроизводимым, затруднило бы смену provider и
позволило бы скрыть ручную правку под меткой «AI».

В проекте пока нет утверждённых provider, credentials, тарифов или benchmark.
Поэтому архитектура должна разрешить локальные либо внешние adapters, но первый
срез не должен требовать платного API и не должен выбирать Perplexity, OpenAI,
Flux или другого vendor без отдельной проверки официальной документации,
политик, стоимости и качества.

## Текущие ограничения

- Nuxt SPA и NestJS остаются независимыми за `/api/v1` и generated OpenAPI
  client.
- PostgreSQL является authoritative state; Redis/BullMQ — disposable delivery.
- Provider calls и media extraction не выполняются внутри HTTP request.
- AI Content остаётся bounded module текущего modular backend. Реальные AI
  provider calls выполняет независимый `ai-worker`; FFmpeg extraction остаётся
  в `media-worker`.
- Existing `EditorialPackageRevision`, `EditorialApproval` и export artifacts
  immutable. Stage 2B создаёт новые revisions и не переписывает историю.
- Source authorization и montage rights продолжают применяться fail-closed.
- Ручной metadata/thumbnail path, preview, approval и export работают при
  выключенном AI, отсутствии credentials, исчерпанном бюджете и provider error.
- Stage 2B не добавляет Twitch ingestion, vertical clips, publishing,
  analytics, public registration, multi-tenancy или mobile UI.
- Automatic highlight detection и внешний clipping provider остаются Stage 3.

## Варианты

### Вариант A: сохранить только ручной Stage 2

Плюсы: нет migration, provider cost и новых workers. Минусы: не достигается
цель Stage 2B и не измеряется экономия ручного времени. Это обязательный
fallback и rollback mode, но не выбранный результат.

### Вариант B: встроить один vendor SDK прямо в editorial controller

Плюсы: короткий первый demo. Минусы: долгий HTTP request, vendor payload в
domain, нет durable retry/cost reservation, слабая lineage и ручной путь может
зависеть от credentials. Противоречит architecture baseline и отклонён.

### Вариант C: вынести orchestration в Airtable/Google Sheets/n8n

Плюсы: быстрое прототипирование внешней автоматизации. Минусы: PostgreSQL
перестаёт быть единственным authoritative workflow state, exact approval и
rights gates легко обойти, private transcript/prompts/likeness уходят в ещё одну
систему, recovery и cost accounting разделяются. Такой UI/automation adapter
может появиться позже поверх REST API, но не является core pipeline.

### Вариант D: owned AI Content module, exact evidence и provider-neutral ports

Плюсы: сохраняет manual path и ADR-007, даёт сменяемые adapters, durable jobs,
cost ceilings, citations и exact provenance. Первый slice остаётся небольшим и
без provider calls; следующие slices добавляются вертикально. Минусы: нужны
additive data model, новый `ai-worker`, отдельные job/resource pools и больше
integration/recovery tests. Это выбранный вариант.

## Решение

Stage 2B реализуется серией bounded vertical slices. Первый slice сохраняет
профиль, права и редакционный контекст без AI job. Provider adapters и workers
добавляются только в следующих slices после freeze соответствующего contract.

`AI Content` владеет creator profiles, editorial contexts, evidence/generation
intents, research snapshots, suggestion sets, usage/cost ledger и их ports.
Финальный пользовательский title/description/tags и выбранная thumbnail
по-прежнему принадлежат `editorial-content` как новая
`EditorialPackageRevision`. Межмодульная запись выполняется через application
port/use case, а не прямым доступом AI module к editorial repositories.

### 1. Creator profile и likeness

`CreatorProfile` — стабильный aggregate с append-only
`CreatorProfileRevision`. Revision содержит:

- canonical display name;
- обязательный operator-supplied official HTTPS URL;
- primary language и bounded ordered topics;
- editorial notes и restrictions для оператора;
- `likenessPolicy`: `NO_REALISTIC_LIKENESS` либо
  `CLEARED_REFERENCE_ONLY`;
- exact default reference asset/authorization revision, только когда policy
  разрешает likeness.

Profile находится в одном private operator catalog и намеренно переиспользуется
между project одного локального deployment. Он не является tenant-scoped:
multi-tenancy отсутствует в baseline. Project/source получает только exact
profile revision через `SourceEditorialContext`; cross-project media/context
lineage при этом остаётся fail-closed. Если появятся разные владельцы или public
access, tenant ownership потребует отдельного ADR до открытия этих routes.

Official URL — идентификатор контекста, а не доказательство прав и не команда
серверу скачать страницу. Backend его не fetch-ит. Canonicalization contract
`creator-official-url-v1` принимает только HTTPS без credentials, query и
fragment, lower-case/IDNA-normalizes host, удаляет default port `443`, dot
segments, percent-encoding unreserved characters и trailing slash кроме root;
path case сохраняется. Frontend открывает URL только как external
`noopener,noreferrer` link.

Semantic identity URL резервируется навсегда за одним profile в отдельной
`CreatorProfileOfficialUrlIdentity` с DB-unique canonical value. Revision
ссылается на exact URL identity. Новый URL того же profile создаёт ещё один
identity/alias, а старый не освобождается для другого profile. Concurrent create
или update с URL/alias другого profile даёт
`CREATOR_PROFILE_OFFICIAL_URL_CONFLICT`; automatic merge запрещён. Same profile
и семантически тот же canonical URL является обычным idempotent/no-conflict
update. Profile merge/delete/перенос URL требует отдельного решения.

Reference photo хранится отдельным immutable private
`CreatorReferenceAsset`, не как `EditorialAsset/THUMBNAIL`. Upload использует
те же строгие JPEG/PNG/WebP structural limits, bounded streaming, checksum и
cleanup guarantees, но отдельный object namespace и ownership.

Каждая reference asset имеет versioned authorization:

- `NOT_REVIEWED` — default, provider transfer и likeness generation запрещены;
- `CLEARED` — оператор явно attested commercial/AI-image use, basis,
  declaration version, scope, optional expiry и разрешение либо запрет external
  provider transfer;
- `REVOKED` — новые generation запрещены; historical lineage сохраняется.

Переходы разделены намеренно:

1. Create profile создаёт revision 1 с `NO_REALISTIC_LIKENESS`, без default
   reference.
2. Upload создаёт asset в `NOT_REVIEWED` и не меняет profile revision.
3. Authorize append-ит exact authorization revision и не выбирает asset по
   умолчанию.
4. Отдельная CAS-команда `set-default-reference` создаёт новую profile revision
   и фиксирует exact `(assetId, authorizationRevisionId/revision)`. Она проходит
   только для latest `CLEARED`, non-expired authorization. Очистка default
   создаёт новую revision с `NO_REALISTIC_LIKENESS`.

Derived likeness usability требует, чтобы profile revision была current,
selected asset READY, captured authorization была latest и всё ещё
`CLEARED`/non-expired. Более новая authorization revision, включая re-clear
после revoke, делает default `DEFAULT_REFERENCE_AUTHORIZATION_CHANGED` до новой
explicit CAS set-default. `REVOKED`/expired даёт отдельный blocker немедленно;
historical profile revision не переписывается.

Usability вычисляется по requested capability. Research, text, transcript и
`NO_LIKENESS_IMAGE` требуют current profile/context chain, но не требуют
reference. Только `REALISTIC_LIKENESS_IMAGE` дополнительно требует usable
default reference. Поэтому revoke не останавливает независимый text job, но ни
один likeness job не может обойти revoke через общий статус profile.

Имя, official URL, право на исходное видео и публичная фотография сами по себе
не дают likeness authorization. Реалистичное лицо конкретного человека
запрещено без exact `CLEARED` reference. Если reference отсутствует, истёк,
revoked или external transfer запрещён, допустимы только обложка без
реалистичного likeness, ручная загрузка либо local adapter, который не передаёт
reference внешней стороне.

### 2. Source context и per-cut prompt

`SourceEditorialContext` адресуется exact `(projectId, sourceId,
sourceVersion)` и имеет append-only revisions. Revision фиксирует exact creator
profile revision, source/original title supplied by operator, game/topic,
audience, editorial goal, language, claims/restrictions и default CTA. Оно не
заменяет `SourceAuthorization`.

`CutEditorialPrompt` адресуется exact READY `CUT_SEGMENT` job/result artifact и
также append-only. Revision фиксирует exact source-context revision, описание
происходящего в этом отрезке, desired angle, tone, CTA и запреты. Prompt —
operator instruction, а не доказанный факт. Несовпадение project/source/version
или non-READY/tampered cut fail closed.

CAS `expectedRevision` и module-wide durable idempotency ledger защищают все
mutation. Same key + same versioned canonical tuple возвращает тот же effect;
same key + другой path/project/body возвращает generic `409` без disclosure.

Current/usability chain вычисляется при каждом evidence/generation/apply read:

```text
current CreatorProfileRevision + capability-specific usability
→ current SourceEditorialContextRevision exact sourceVersion
→ current CutEditorialPromptRevision exact cut artifact
→ current EditorialEvidenceBundle
→ generation/apply
```

Новая profile revision делает связанные source contexts `STALE`; новая source
context revision делает cut prompts `STALE`; новая cut prompt revision делает
старый evidence intent/bundle непригодным для новых generations. История
остаётся читаемой. Чтобы продолжить, оператор явно создаёт следующую downstream
revision; система не «перепривязывает» её автоматически.

### 3. Transcript и sparse-frame lineage

Evidence никогда не прикрепляется только к mutable project или filename.
`EditorialEvidenceIntent` фиксирует:

- project/source/version и exact cut job/result artifact ID, SHA-256 и bytes;
- exact source-context и cut-prompt revisions;
- evidence contract/recipe versions;
- requested transcript language и deterministic sparse-frame sampling policy.

Transcript и каждый frame являются private immutable artifacts с content type,
bytes, SHA-256, timestamp/range и extractor/provider provenance.
`EditorialEvidenceBundle` становится `READY`, только когда его exact required
components готовы и проходят checksum/lineage. Partial/failed components
остаются видимыми и не превращаются в пустой «успех».

Evidence admission, media/AI worker claim, непосредственно pre-provider dispatch
и result finalization повторно вычисляют всю current/capability-usability chain.
Job, который оставался `QUEUED`, после profile/context/prompt change или
релевантного reference revoke не читает newly disallowed reference/transcript/
frame input и завершается typed stale/rights outcome. Для внешней передачи
reference worker атомарно фиксирует `providerDispatchStartedAt` и exact current
policy fingerprint сразу перед call. Revoke, committed раньше этого CAS,
запрещает call; уже начатый внешний
request нельзя физически отозвать, но revoke запрещает retry, candidate
finalization и дальнейшее использование результата.

FFmpeg sparse-frame extraction принадлежит `media-worker` и отдельному bounded
media resource class. Transcription принадлежит `ai-worker` за owned
`TranscriptionProvider`; local model и external provider являются adapters
одного port. API только сохраняет intent и dispatch references. Raw transcript
bytes и frames хранятся в private object storage; PostgreSQL хранит identities,
segments/index metadata, checksums и lineage, но не большие blobs.

### 4. Provider-neutral research, text и image ports

Domain/application code использует owned ports:

- `WebResearchProvider` возвращает normalized research snapshot и citations;
- `TranscriptionProvider` возвращает transcript artifact/segments;
- `TextGenerationProvider` возвращает schema-validated metadata variants;
- `ImageGenerationProvider` возвращает private image candidates и safety data.

Provider/model names, SDK DTO, request IDs и raw responses не протекают в
public editorial DTO. Adapter capabilities явно сообщают idempotency/status
lookup, reference-image support, usage reporting, data retention и supported
safety controls. Неподдерживаемая обязательная capability закрывает admission,
а не отключает gate.

Каждый provider call — отдельный durable job/intention с exact input snapshot,
provider adapter version, model, prompt template version, normalized parameter
fingerprint и attempt. Research, text и image могут завершаться независимо:
ошибка image не уничтожает text result и наоборот.

### 5. Research freshness и citations

`ResearchSnapshot` immutable и содержит normalized query/context fingerprint,
provider/model/adapter version, `searchedAt`, `freshUntil`, bounded citations и
result checksum. Citation содержит server-owned ID, normalized HTTPS URL,
title, publisher, provider-reported published time when available и
`accessedAt`. Отсутствующая publish date не выдумывается.

Freshness определяется versioned server policy по типу запроса. Expired
snapshot не используется для нового factual generation: UI предлагает refresh
или manual path. Research provider обязан вернуть хотя бы одну citation для
factual claims; text variant связывает factual claims с citation IDs. Creative
copy без фактических утверждений может явно иметь пустой claim set. Citation
является источником, а не гарантией истинности; human review остаётся обязателен.

Transcript, web pages, citation text и user prompt считаются untrusted data, а
не system instructions. Adapter разделяет policy/instructions и quoted source
material, использует schema-constrained output и reject-ит malformed/oversized
response. Backend не fetch-ит произвольные citation URLs от имени browser.

### 6. Metadata/thumbnail provenance

Каждая новая `EditorialPackageRevision` имеет immutable component provenance
отдельно для metadata и thumbnail:

- `MANUAL`: component создан без выбранного AI candidate;
- `AI_ASSISTED`: сохранён exact candidate без содержательной ручной правки;
- `MIXED`: exact candidate использован как основа, но итог отличается либо AI
  candidate был отредактирован/дополнен вручную.

Mode вычисляет server из exact candidate reference и normalized final bytes/
fields; client не может объявить себе `AI_ASSISTED`. Metadata provenance
фиксирует suggestion set/variant, research/evidence/context/prompt revisions,
provider/model/prompt version, citation IDs и cost record. Thumbnail provenance
независимо фиксирует manual upload либо image candidate, exact bytes,
reference-authorization revision и likeness safety decision.

После apply обычное изменение profile/source-context/cut-prompt не переписывает
уже созданную final editorial revision. Но если `AI_ASSISTED` или `MIXED`
thumbnail provenance использует realistic likeness, current approval/export/
download дополнительно требуют, чтобы captured reference authorization была
latest, `CLEARED`, non-expired и не revoked. Нарушение переводит approval в
`STALE` с safe likeness-rights reason и блокирует новый export/current package
download; historical artifact остаётся private. Полностью manual thumbnail
(включая manual metadata + manual thumbnail) от profile/context/reference
change не инвалидируется. Text-only AI provenance также не получает likeness
gate.

Legacy revisions без отдельной row читаются как
`MANUAL / legacy-manual-editorial-v1`; migration не переписывает media objects.
Новые manual saves создают explicit `MANUAL` provenance без AI dependency.

AI generation не изменяет approved content при failure. Успешная операция
«применить/перегенерировать текущий component» создаёт новую current
`EditorialPackageRevision`; поэтому ADR-007 автоматически переводит прежний
approval/export в `STALE`. Discarded preview candidate, который ни разу не стал
current component, historical approval не меняет. UI не называет candidate
готовым к публикации до save → preview → нового explicit approval.

Это уточняет формулировку roadmap «повторная генерация снимает подтверждение»:
подтверждение снимает успешная регенерация выбранного/current component, то
есть новая final editorial revision. Provider failure или просмотр
неприменённого candidate не изменяют exact approved bytes.

### 7. Cost ceilings и authoritative usage

Каждая billable operation имеет обязательный server-bounded maximum cost в USD
microunits, project budget period, versioned rate-card estimate и provider
native usage/cost when returned. Перед dispatch PostgreSQL transaction
резервирует worst-case cost; concurrent jobs не могут превысить доступный
project/provider budget. После terminal result reservation заменяется actual
cost либо безопасным configured upper bound.

Adapter без достоверного usage и без versioned worst-case estimator не допускается
к billable call. Currency conversion не выдумывается: native value/currency и
rate-card conversion snapshot сохраняются отдельно. UI различает estimate,
reserved и actual; electricity, hardware, Codex engineering limits и human
labor не смешиваются с direct provider cost.

Локальные/manual adapters могут иметь direct provider cost `0` только с
явным basis version. Feature flags и default project budget держат внешние
providers admission-disabled до проверки credentials и owner approval.

### 8. Controlled failure, idempotency и recovery

AI jobs используют PostgreSQL state/lease/attempt/retry budget и BullMQ только
для delivery. Per-provider concurrency, rate limit, circuit state и cost
reservation образуют отдельные pools, не занимая FFmpeg slot.

До external call worker сохраняет exact request fingerprint и deterministic
client operation ID. Если provider поддерживает idempotency/status lookup,
retry переиспользует identity и сначала reconciles outcome. Если outcome
billable call неоднозначен, а provider не умеет idempotency/reconciliation,
worker не делает blind paid retry: job завершается controlled
`PROVIDER_OUTCOME_UNKNOWN`, reservation сохраняется как upper bound, UI
предлагает explicit new attempt. Duplicate queue delivery и lost lease не могут
создать второй authoritative candidate/artifact.

Перед каждым provider call worker выполняет atomic pre-dispatch CAS с latest
profile/context/prompt/rights policy fingerprint. Stale queued/retry job не
вызывает provider. После provider response finalization повторяет проверку; результат
устаревшей или revoked цепочки сохраняется только как unusable attempt evidence
либо удаляется durable cleanup, но не становится selectable candidate.

Timeout, 429/5xx и temporary network failure retryable только когда adapter
доказывает safe retry. Invalid credentials, budget exhausted, stale context,
missing citation, malformed output, safety refusal, revoked likeness rights,
checksum mismatch и unsupported contract дают typed controlled failure. Ни один
из них не меняет current manual editorial revision и не блокирует manual save,
preview, approval или export.

## Минимальный первый vertical slice: Stage 2B-1

Первый slice — **Creator Context & Manual Provenance Foundation**:

1. CRUD/revisions/reload для `CreatorProfile` с обязательным official URL.
2. Private reference image upload, explicit authorization/revoke и fail-closed
   likeness policy; никаких image generation/provider calls.
3. Exact source-context и per-cut prompt revisions с project/source/cut lineage.
4. Explicit manual component provenance для новых editorial revisions и
   legacy-manual read compatibility.
5. Один desktop UI workspace, где оператор создаёт профиль, связывает его с
   source, задаёт cut prompt и видит «likeness запрещён/разрешён» и
   `MANUAL` provenance после reload.

Slice не добавляет `PipelineJob`, Redis message, ai-worker, FFmpeg, transcript,
research, text/image generation или платный provider. Поэтому он даёт
проверяемый пользовательский результат и foundation без горизонтального слоя
неиспользуемых integrations.

## Последовательность следующих slices

1. **Stage 2B-2 — Sparse-frame evidence.** Exact evidence intent, отдельный
   `media-worker` job, private frames, real progress, retry/recovery/Range.
2. **Stage 2B-3 — Transcript evidence and ai-worker foundation.** Новый
   independently deployable `ai-worker`, `TranscriptionProvider`, bounded AI
   pool, transcript artifact/segments и complete evidence bundle. Начать с
   ручного/local test adapter; внешний provider только после benchmark.
3. **Stage 2B-4 — Cited research and text suggestions.** Research snapshot,
   freshness/citations, cost reservation и editable title/description/tag
   variants. Apply создаёт новую editorial revision с server-derived
   `AI_ASSISTED`/`MIXED` metadata provenance.
4. **Stage 2B-5 — Thumbnail suggestions.** Image port, no-likeness path первым;
   затем exact cleared-reference path после provider privacy/rights review.
   Apply создаёт private thumbnail и независимую image provenance. В этом же
   slice ADR-007 currentness/export/content-read gates расширяются ongoing
   likeness authorization policy; manual thumbnail path не меняется.
5. **Stage 2B-6 — Integrated review and economics.** Единый UI для regenerate,
   compare, edit, citations/freshness/cost, exact approval invalidation и
   export manifest contract v2; реальный manual/AI/mixed E2E и operator-time
   benchmark.

Каждый slice получает отдельные acceptance criteria и independent real-diff
review. Frontend начинается только после freeze соответствующего OpenAPI.

## REST/OpenAPI boundaries первого slice

Предлагаемый additive REST v1:

- `POST /api/v1/creator-profiles`;
- `GET /api/v1/creator-profiles?cursor=&limit=`;
- `GET /api/v1/creator-profiles/:profileId`;
- `GET /api/v1/creator-profiles/:profileId/revisions?cursor=&limit=` и
  `GET /api/v1/creator-profiles/:profileId/revisions/:revision`;
- `PUT /api/v1/creator-profiles/:profileId` — append revision с
  `expectedRevision`;
- `POST /api/v1/creator-profiles/:profileId/reference-assets` — bounded
  multipart upload;
- `PUT /api/v1/creator-profiles/:profileId/reference-assets/:assetId/authorization`;
- `GET /api/v1/creator-profiles/:profileId/reference-assets/:assetId/authorization`;
- `PUT /api/v1/creator-profiles/:profileId/default-reference` — explicit CAS
  select/clear exact asset + authorization revision;
- `GET /api/v1/creator-profiles/:profileId/reference-assets?cursor=&limit=`;
- `GET /api/v1/creator-profiles/:profileId/reference-assets/:assetId/content`
  — private bounded Range;
- `PUT /api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context`;
- `GET /api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context`;
- `GET /api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context/revisions?cursor=&limit=`;
- `PUT /api/v1/pipeline-jobs/:cutJobId/editorial-prompt`;
- `GET /api/v1/pipeline-jobs/:cutJobId/editorial-prompt`.

Все mutation требуют `Idempotency-Key`; revision updates также требуют
`expectedRevision`. Module ledger хранит optional resolved project/source для
context operations и exact profile/reference identity для global private-catalog
operations. Profile list является redacted summary и не содержит operator notes
или restrictions. Private profile current/revision detail и private source/cut
detail возвращают nested `editableRevision`, field-for-field совпадающий с
соответствующим full PUT body кроме `expectedRevision`, плюс отдельные read-only
identity/usability fields. Это обеспечивает lossless round-trip private notes и
restrictions без отправки их в list;
reference authorization detail возвращает basis/scope/expiry/transfer decision,
но не literal declaration text. Никакой DTO не содержит object keys или storage
credentials. Pagination cursor opaque и bounded. Frontend использует только
regenerated OpenAPI client; raw HTTP и handwritten DTO запрещены.

## Persistence и module boundaries первого slice

Additive migration добавляет stable aggregate/current-revision rows,
append-only profile/context/prompt revisions, private reference asset и exact
authorization, module-wide operation request ledger и one-to-one editorial
component provenance. Composite keys/FKs доказывают project/source/version/cut
lineage там, где это поддерживает PostgreSQL; остальные invariants повторно
проверяются внутри serializable application transaction.

Отдельная URL identity table имеет unique `(canonicalizationVersion,
canonicalUrl)` и immutable owner `creatorProfileId`; current/historical profile
revision ссылается на exact identity. Source context stable identity и unique key
обязательно включают `(projectId, sourceId, sourceVersion)`, а history pagination
не может смешать версии одного source.

`AI Content` не читает Prisma repositories `Sources` или `editorial-content`
напрямую. Он получает exact authorized read models через owned application
ports. `editorial-content` принимает provenance snapshot через versioned command
contract и остаётся единственным writer `EditorialPackageRevision`.

Owned `ResolveAiEditorialContext` query/port возвращает exact current chain,
capability-specific blockers и deterministic `contextPolicyFingerprint` из
profile/source-context/cut-prompt/latest authorization revisions. API admission
и будущие workers используют один resolver; они не воспроизводят policy
независимыми direct repository joins.

Reference objects private и immutable; PostgreSQL хранит SHA/bytes/content type,
object storage receipt и cleanup state. Upload commit ambiguity обрабатывается
authoritative reread; object удаляется только по durable cleanup intent. Profile
или context delete в первом slice отсутствует. Это сохраняет lineage и избегает
случайной потери reference/rights evidence.

## Миграция и rollout

1. Добавить schema/API/OpenAPI и UI behind `AI_CONTEXT_ENABLED=0`; никаких
   provider credentials не требуется.
2. Пройти isolated PostgreSQL migration, API integration, object cleanup,
   generated-client и manual Stage 2 regression.
3. Проверить active jobs read-only и сохранить forward-compatible API build,
   который понимает additive rows, но имеет admission off.
4. Применить migration, запустить API admission-off и доказать прежний upload →
   cut → editorial → approval → export.
5. Включить только context/profile routes и выполнить real local browser
   create → upload reference → authorize → explicit set-default → bind exact
   source version/cut → reload → revoke smoke.
6. Не включать AI jobs/providers до отдельных accepted task/rollout gates.

Следующие job slices развёртывают capable worker до API admission, как ADR-006 и
ADR-007. Unknown job type всегда fail closed.

## Rollback

Выключить `AI_CONTEXT_ENABLED`, скрыть UI/routes и вернуть сохранённый
forward-compatible admission-off API. Additive tables, revisions, rights rows и
private objects сохраняются; down migration и physical deletion не выполняются.
Existing manual editorial saves продолжают создавать/читать manual provenance;
legacy missing provenance остаётся совместимым. Stage 1/2 upload, cutting,
assembly, approval и ZIP export не зависят от Stage 2B.

После появления AI jobs rollback сначала выключает provider admission, затем
drain/controlled-finalize новые types и возвращает только binaries, которые их
понимают. Credentials можно удалить после остановки provider admission; это не
удаляет historical normalized provenance.

## Безопасность и privacy

- Reference photos, transcripts, frames, prompts, provider inputs/outputs и raw
  research являются private data; object keys и content не попадают в logs.
- Reference photo может являться персональными/likeness data. Перед внешней
  передачей нужны exact rights row, `externalProviderTransferAllowed=true`,
  поддерживаемая provider policy и generation-specific consent snapshot.
- Research provider не получает reference photo, private rights notes или
  source media. Image provider не получает transcript целиком, если bounded
  generated brief достаточен.
- Provider credentials хранятся только в environment/secret storage и не
  возвращаются API. Prompt/response telemetry содержит IDs, versions, bytes,
  durations, tokens and costs, но не content.
- All inputs имеют server-owned limits. Image bytes проходят structural
  validation и decompression-bomb checks; generated images проходят ту же
  validation до READY.
- URLs не исполняются как instructions и не fetch-ятся core API. UI sanitizes
  text/links; no HTML from provider is rendered.
- Provider terms, retention/training policy и deletion support фиксируются в
  adapter review до включения реальных credentials.

## Стоимость и долгосрочные последствия

Первый slice не добавляет direct provider cost и не требует нового runtime
process. Он добавляет небольшие PostgreSQL rows и private reference images.
Следующие slices добавляют отдельный `ai-worker`; он может работать на той же
локальной машине и масштабироваться независимо. Платный provider выбирается по
измеренным quality/latency/cost и официальному API, а не по consumer chat
subscription.

Owned normalized snapshots и ports увеличивают начальный объём разработки, но
сохраняют сменяемость provider, audit и возможность local models. Хранение raw
provider payload по умолчанию запрещено; включение ограниченной encrypted/debug
retention требует отдельной policy.

## Измеримые критерии успеха архитектуры

1. Полный Stage 2 manual smoke проходит с `AI_CONTEXT_ENABLED=0`, без provider
   credentials и без новых queue messages.
2. Profile/source/cut contexts восстанавливаются после reload и сохраняют exact
   revision/lineage; cross-project и stale revision requests fail closed.
3. Semantic duplicate official URL не создаёт второй profile при concurrent
   create/update; old alias остаётся зарезервирован, automatic merge отсутствует.
4. Likeness generation невозможно без explicit CAS-selected exact current
   cleared reference rights; revoke/expiry блокирует queued/new use, historical
   evidence не переписывается.
5. Evidence, research и generation result можно проследить до exact cut bytes,
   contexts, provider/model/prompt/adapter versions, citations and cost record.
6. Metadata и thumbnail независимо возвращают честный server-derived
   `MANUAL`, `AI_ASSISTED` или `MIXED`.
7. Successful apply/regenerate создаёт новую editorial revision и делает
   прежний approval `STALE`; provider failure не изменяет current revision.
8. Likeness revoke делает AI-derived likeness approval/export/download stale,
   но не меняет manual approval. Stale queued work не вызывает provider.
9. Budget reservation не допускает overspend при concurrent jobs; ambiguous
   billable outcome не делает blind duplicate call.
10. Expired research, absent citations, malformed provider output, timeout,
    safety refusal и missing credentials дают typed controlled failures, при
    этом manual save/approval/export остаются доступны.
11. Reference/transcript/frame/provider content и credentials отсутствуют в
    public DTO/logs; private objects доступны только через authorized bounded
    endpoints.
12. Prisma migration/validate, OpenAPI drift, lint/format/typecheck/build,
    unit/integration/recovery, controlled failure, browser smoke и independent
    real-diff review проходят для каждого slice.

## Explicit out of scope

- Twitch ingestion и monitoring;
- automatic highlight detection и provider vertical clipping;
- YouTube/TikTok publishing, scheduling, channel credentials и analytics;
- OCR/face recognition, biometric identification или поиск лица по интернету;
- обучение собственной модели на reference photos;
- autonomous factual publication без citations/human approval;
- n8n/Airtable/Google Sheets как authoritative core state;
- multi-tenancy, public auth, billing, mobile UI;
- microservices, Kubernetes, GraphQL, event sourcing;
- выбор/покупка provider, VDS или GPU и повышение media concurrency.

## Решение tech lead

Approved: вариант D принят, Stage 2B-1 авторизован к реализации. Остальные
Stage 2B slices требуют отдельных acceptance criteria, provider evidence и
CLEAN review. Live migration/runtime rollout Stage 2B-1 остаётся запрещён до
independent CLEAN review реализации; provider credentials и AI job admission
остаются запрещены этим решением.
