# Stage 2B-1 — Creator Context & Manual Provenance Foundation

Статус: architecture accepted; implementation authorized, live rollout gated by independent implementation review
Дата: 2026-09-06
Владелец реализации: один Backend Engineer — Creator Context Foundation;
после freeze OpenAPI — один Frontend Engineer — Creator Context Workspace

## Пользовательский результат

Оператор создаёт переиспользуемый профиль стримера с обязательной официальной
ссылкой, сохраняет точный контекст исходника и отдельный prompt отрезка. Он может
загрузить private reference image, отдельно подтвердить либо отозвать право на
likeness use и после reload увидеть точные revisions и понятный статус:
«реалистичное лицо запрещено» либо «разрешено только с этой reference».

Existing manual editorial form продолжает работать без профиля, reference,
Redis, worker и AI credentials. Новые manual package revisions получают честную
server-owned provenance `MANUAL` отдельно для metadata и thumbnail; legacy
manual revisions читаются совместимо.

## Граница slice

### Входит

- additive persistence/API/OpenAPI для creator profile revisions;
- bounded private reference image upload/read/list;
- exact reference authorization `NOT_REVIEWED/CLEARED/REVOKED`;
- source-context revisions exact source version;
- per-cut prompt revisions exact READY cut artifact;
- module-wide mutation idempotency и CAS;
- manual/legacy component provenance seam;
- desktop-only PrimeVue workspace и reload/error UX;
- feature flag, migration/rollback, tests и documentation.

### Не входит

- ai-worker, provider SDK/credentials или платные calls;
- transcript, sparse frames, research, citations или generated suggestions;
- image generation и передача reference внешнему provider;
- изменения render/FFmpeg, Twitch, vertical, publishing или analytics;
- изменение existing approval/export contract либо ZIP manifest;
- delete/retention UI, mobile UI и повышение concurrency.

## Backend ownership

Один implementer владеет:

- одной additive Prisma migration/schema/generated Prisma;
- новым bounded module `apps/api/src/ai-content/**`;
- минимальным versioned provenance integration через owned
  `editorial-content` application port/use case;
- generated OpenAPI artifacts и API tests.

Он не меняет worker apps, queue job union, FFmpeg, infrastructure, lockfile или
frontend. Если новая dependency кажется необходимой, implementation
останавливается: для этого slice она не ожидается.

## REST v1 acceptance

### Creator profile

- `POST /api/v1/creator-profiles` принимает canonical name, official URL,
  language, topics и operator-private notes/restrictions. Revision 1 всегда
  создаётся с `NO_REALISTIC_LIKENESS` и без default reference. Требует
  `Idempotency-Key`.
- `PUT /api/v1/creator-profiles/:profileId` принимает full next revision и
  `expectedRevision`; PATCH/partial merge не используется. Команда редактирует
  descriptive fields, а exact default reference server копирует без изменения;
  менять default может только отдельный CAS endpoint.
- `GET /api/v1/creator-profiles?cursor=&limit=` возвращает redacted summaries
  без operator notes/restrictions и rights detail.
- Private `GET /api/v1/creator-profiles/:profileId`, bounded revision list и
  `GET .../revisions/:revision` возвращают полный round-trip aggregate, включая
  operator-private notes/restrictions, exact official URL identity и default
  reference snapshot. Nested `editableRevision` field-for-field совпадает с
  full PUT payload кроме `expectedRevision`; default snapshot остаётся отдельным
  read-only field. UI может без потери private fields отправить detail
  `editableRevision` обратно в full PUT.
- Profile находится в едином private operator catalog и может быть выбран в
  нескольких projects. Project/media data не становится частью profile DTO;
  tenant/public access в этом slice отсутствует.
- Official URL обязателен и нормализуется только по
  `creator-official-url-v1`: HTTPS, без credentials/query/fragment;
  lower-case/IDNA host, без default `443`, normalized dot segments/unreserved
  percent encoding/trailing slash, но с сохранением path case. Он не fetch-ится
  backend.
- Canonical URL имеет permanent DB semantic uniqueness через immutable URL
  identity/alias owner. Same profile + semantic same URL — no-conflict;
  different profile или concurrent create/update на current/old alias —
  `409 CREATOR_PROFILE_OFFICIAL_URL_CONFLICT`. Automatic merge отсутствует;
  conflict response private UI направляет к существующему profile. Старый alias
  после update не освобождается.
- Empty/duplicate topics нормализуются детерминированно либо отклоняются по
  frozen DTO rule; silent reorder запрещён.

### Reference asset и authorization

- `POST /api/v1/creator-profiles/:profileId/reference-assets` принимает один
  JPEG/PNG/WebP multipart с `Idempotency-Key` и server limits не слабее current
  thumbnail validator.
- Upload сохраняет original safe filename, detected content type, dimensions,
  bytes, SHA-256 и private object receipt. Fake MIME, SVG, corrupt/truncated
  bytes, unsupported WebP, excessive dimensions/pixels/bytes и multiple files
  отклоняются controlled.
- Same key + same exact upload fingerprint возвращает тот же asset; same key +
  другой profile/file даёт generic `409`. Ambiguous commit выполняет reread,
  object cleanup только через durable intent.
- New asset всегда `NOT_REVIEWED`; upload не подтверждает rights.
- `PUT .../reference-assets/:assetId/authorization` требует
  `expectedRevision`, literal declaration version и explicit attestation для
  commercial AI-image use, basis/scope, optional expiry и
  `externalProviderTransferAllowed`. Revoke является отдельным explicit next
  revision и идемпотентен.
- Authorize/revoke не изменяют profile и не выбирают asset автоматически.
  Private `GET .../reference-assets/:assetId/authorization` возвращает current
  revision и bounded history/detail с basis/scope/expiry/transfer decision,
  достаточными для осознанного следующего PUT; literal declaration text не
  возвращается.
- `PUT /api/v1/creator-profiles/:profileId/default-reference` — единственная
  set/clear команда. Она требует `expectedProfileRevision`, exact `assetId` и
  exact `authorizationRevisionId/revision`, либо explicit clear. Set атомарно
  проверяет READY asset и latest `CLEARED`, non-expired authorization и создаёт
  новую profile revision с `CLEARED_REFERENCE_ONLY`; clear создаёт новую
  revision с `NO_REALISTIC_LIKENESS`.
- Derived usability требует current profile revision, READY selected asset и
  captured authorization, которая остаётся latest/CLEARED/non-expired. Любая
  более новая authorization revision даёт
  `DEFAULT_REFERENCE_AUTHORIZATION_CHANGED` до нового explicit set-default;
  `REVOKED`/expiry дают отдельный fail-closed blocker немедленно.
- `CLEARED` без полной attestation, wrong profile/asset, stale authorization
  selection либо selected `NOT_REVIEWED/REVOKED` reference не создают новую
  profile revision.
- Usability capability-specific: research/text/transcript/no-likeness image не
  требуют reference; realistic-likeness image требует exact usable default.
  Revoke блокирует likeness chain, но сам по себе не блокирует text-only work.
- List/content endpoints проверяют exact profile/reference ownership внутри
  private operator catalog. Content поддерживает existing one bounded Range/206
  semantics и никогда не раскрывает object key/storage credential.

### Source context

- `PUT /api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersion/editorial-context`
  принимает exact creator profile revision, `expectedRevision`, title/game/
  topic/audience/goal/language/default CTA и bounded restrictions.
  `sourceVersion` находится в path и canonical request identity, а не
  неавторитетно только в body.
- Source/project/version и profile revision повторно разрешаются в одной
  transaction. Wrong/stale lineage не создаёт aggregate/revision.
- Same-key replay возвращает тот же revision; concurrent different keys с
  одинаковым expected revision дают один success и один controlled `409`.
- `GET` current/detail и обязательный bounded history route используют тот же
  exact path tuple `(projectId, sourceId, sourceVersion)`. Cursor привязан к
  этому tuple; данные другой source version не смешиваются и не возвращаются
  даже при повторном использовании cursor. Private detail содержит полный
  `editableRevision` с operator restrictions/notes для lossless full PUT;
  summary/list projection этих полей не имеет.

### Per-cut prompt

- `PUT /api/v1/pipeline-jobs/:cutJobId/editorial-prompt` принимает exact
  source-context revision, `expectedRevision`, what-happens/angle/tone/CTA и
  bounded restrictions.
- Target обязан быть exact project-owned `CUT_SEGMENT/READY` с READY result,
  exact source/version/checksum lineage и usable source authorization.
- Source context другого project/source/version и arbitrary pipeline job fail
  closed. Prompt text не интерпретируется как trusted/system instruction.
- `GET` восстанавливает current/history после full reload.
- Prompt private detail аналогично возвращает полный `editableRevision`; prompt
  text/restrictions отсутствуют в summary/list и telemetry.

API возвращает derived `CURRENT/STALE` и blocker chain. Current cut prompt
требует current referenced source-context revision; current source context —
current referenced creator-profile revision. Отдельный capability usability
blocker сообщает, доступен ли realistic likeness с selected default reference.
Новая upstream revision не перепривязывает downstream row: source context либо
cut prompt становится `STALE`, history остаётся читаемой, а оператор создаёт
следующую explicit revision.

Все mutation используют один AI Content operation ledger с globally unique key
внутри module и versioned canonical tuple, включающим operation, path target,
exact profile/reference, optional resolved project/source/version, expected
revision и normalized full body. Reuse key в другой operation конфликтует.
Replay context operation сначала повторно проверяет project/source scope и не
раскрывает cross-project result.

Canonical tuple source-context operations обязательно содержит path
`projectId`, `sourceId`, integer `sourceVersion`, exact profile revision и full
normalized private body. Prompt tuple содержит resolved exact source version,
cut artifact/checksum и source-context revision. Idempotency replay не может
перенести result между версиями одного source.

## Persistence acceptance

Migration только additive и сохраняет существующие rows/objects. Минимальные
concepts:

- stable `CreatorProfile` + append-only `CreatorProfileRevision`;
- immutable `CreatorProfileOfficialUrlIdentity` aliases с canonical URL owner;
- immutable `CreatorReferenceAsset` + append-only exact authorization decision;
- stable `SourceEditorialContext` + append-only revision;
- stable `CutEditorialPrompt` + append-only revision;
- one module-wide `AiContentOperationRequest` ledger;
- immutable one-to-one metadata/thumbnail provenance для новых
  `EditorialPackageRevision`.

Stable aggregate содержит monotonic `currentRevision`; revision identity
защищена unique `(aggregateId, revision)`. Composite identity/FK/checks
закрывают exact profile/reference, project/source/version и cut lineage.
`objectKey`, internal error и literal rights declaration не попадают ни в один
DTO; operator-private notes/restrictions отсутствуют только в redacted list и
присутствуют в private detail projection для round-trip edit.

`CreatorProfileOfficialUrlIdentity` имеет DB unique
`(canonicalizationVersion, canonicalUrl)` и immutable `creatorProfileId`.
Profile revision указывает exact URL identity и exact default reference asset/
authorization revision либо оба значения `NULL` при
`NO_REALISTIC_LIKENESS`. Source-context stable key и every revision include
`projectId + sourceId + sourceVersion`; schema не допускает один aggregate на
несколько source versions.

Private detail projection возвращает notes/restrictions и полный revision,
list projection выбирает только redacted columns. Нельзя реализовать list через
full DTO с последующим frontend redaction: private values не должны покидать API
без необходимости.

Foundation публикует owned application query/port
`ResolveAiEditorialContext` без provider call. Он возвращает exact current chain,
capability-specific blockers и deterministic `contextPolicyFingerprint` из
profile/source-context/cut-prompt/current reference authorization revisions.
Следующие workers обязаны использовать этот resolver при admission, claim,
pre-dispatch CAS и finalization, а не собирать policy прямыми cross-module
repository reads.

Legacy editorial revision без provenance возвращается как:

```text
metadata.mode = MANUAL
metadata.basisVersion = legacy-manual-editorial-v1
thumbnail.mode = MANUAL
thumbnail.basisVersion = legacy-manual-editorial-v1
```

Новая existing manual save transaction атомарно создаёт package revision и
explicit `MANUAL` provenance. Client не передаёт mode. `AI_ASSISTED` и `MIXED`
могут существовать в enum/response contract, но этот slice не имеет команды,
которая способна их создать.

Profile/context/reference изменения не инвалидируют existing manual approval,
потому что не меняют exact approved editorial bytes. Existing manual edit всё
так же создаёт новую package revision и переводит старый approval в `STALE` по
ADR-007.

Future evidence/generation/apply admission обязано пройти current chain profile
revision → source-context revision → cut-prompt revision. Future AI/MIXED
thumbnail provenance с realistic likeness дополнительно сохраняет exact
reference authorization; revoke/expiry делает такой approval/export/current
download `STALE`. Approval с manual thumbnail и text-only AI metadata этим gate
не затрагивается.

## Frontend acceptance после OpenAPI freeze

Один Frontend Engineer владеет новым FSD workflow и минимальными entry points;
он не меняет backend/contracts/generated source вручную.

- Desktop workspace использует PrimeVue и явные кнопки; mobile не проектируется.
- Оператор может создать/выбрать profile, открыть official URL безопасно,
  загрузить reference, увидеть preview/status и выполнить отдельную rights
  attestation/revoke. После authorize он отдельно нажимает явную кнопку
  «Использовать по умолчанию»; upload/authorize сами default не меняют.
- List показывает redacted summary. Edit dialog сначала загружает private detail
  и round-trip сохраняет все notes/restrictions; save не может очистить скрытое
  поле только потому, что list его не содержал.
- При semantic URL conflict UI предлагает открыть existing profile и не делает
  automatic merge/overwrite.
- UI никогда не называет `NOT_REVIEWED` «разрешённым» и явно объясняет, что
  official URL/source rights не дают likeness rights.
- Source context выбирает exact profile revision; cut prompt редактируется возле
  существующей горизонтальной карточки/редакционного dialog без нового player.
- Source-context query key/route всегда включает exact sourceVersion. UI явно
  показывает stale upstream/downstream chain и требует новую source-context/
  cut-prompt revision вместо silent rebind.
- Dirty state не теряется молча при close/project/source switch; conflict
  предлагает reload server revision, а не force overwrite.
- Reload/project switch восстанавливает только project-scoped data. Late
  responses старого target не меняют новый screen.
- Editorial UI показывает независимые badges metadata/thumbnail provenance;
  в этом slice они `MANUAL`, включая explicit legacy basis tooltip.
- Disabled flag или API failure скрывает AI-context action, но не ручной
  metadata/thumbnail/preview/approval/export.
- Remote state принадлежит Vue Query; forms/route/storage проходят Zod;
  generated OpenAPI types не дублируются.

## Controlled failures

- invalid URL/body/idempotency/range/cursor: `400`;
- missing profile/source/cut/reference: project-safe `404`;
- stale expected revision, idempotency conflict, wrong lineage or unusable cut:
  typed `409`;
- semantic official URL owned by another profile:
  `409 CREATOR_PROFILE_OFFICIAL_URL_CONFLICT`, без создания/merge;
- stale/non-latest/not-cleared default reference selection: typed `409` с safe
  blocker code;
- unsupported declaration/media semantics: `422`;
- disabled context admission: `503` только на new Stage 2B mutation, не на
  manual Stage 2;
- storage/transient database upload failure: bounded error с durable cleanup,
  без READY row с отсутствующим object;
- cross-project target всегда fail closed без existence disclosure.

Safe public error содержит code и user action, но не object path, provider
secret, raw DB/storage error, rights note или private text. Logs содержат IDs,
revision, byte counts и code, но не prompt/profile notes/image bytes.

## Idempotency, race и recovery acceptance

1. Same key/same canonical request после lost response возвращает exact same
   resource/revision/asset.
2. Same key с другим path, project, sourceVersion, body/file SHA или operation
   даёт `409`.
3. Semantic equivalent official URLs, включая concurrent different-key create,
   сходятся на одном URL owner: один profile success, второй controlled conflict.
   Update не освобождает old alias; automatic merge отсутствует.
4. Два keys с одним expected revision или set-default transition не создают две
   next profile/context/prompt/authorization revisions.
5. Upload → authorize не меняет profile default. Только exact CAS set-default
   выбирает reference; revoke/expiry/later authorization revision немедленно
   делает derived default unusable до новой explicit selection.
6. Upload crash до commit не оставляет usable asset; crash/ambiguous outcome
   после object upload решается reread + durable cleanup.
7. API restart не теряет profiles/contexts/rights/provenance и не требует Redis.
8. Reference revoke/expiry немедленно меняет derived likeness usability, но не
   удаляет asset/history.
9. Late frontend response и stale cache не переносят profile/context между
   projects или cut cards.

В этом slice нет long-running job; worker retry/reconciliation не изменяются и
новых BullMQ messages быть не должно.

## Security/privacy acceptance

- Reference objects private; anonymous storage read получает denial.
- Redacted list не возвращает operator notes/restrictions или rights detail;
  private current/revision detail возвращает эти editable fields для lossless
  round-trip. Literal declaration text не возвращается; provider transfer
  отсутствует полностью.
- URL никогда не используется для server-side fetch. XSS/link protocols,
  filename traversal и response header injection покрыты tests.
- Structural image validation выполняется по bytes, не только extension/MIME.
- Public OpenAPI/log snapshots не содержат object keys, storage receipt,
  credentials, private notes или uploaded bytes.
- Source authorization gate повторно проверяется для cut context; reference
  rights не подменяют source rights.

## Обязательная проверка

До live migration:

1. Prisma validate/generate и isolated migration на disposable PostgreSQL.
2. Unit/domain tests exact URL canonicalization vectors, permanent semantic
   alias uniqueness, explicit likeness transitions/currentness, staleness chain
   и provenance derivation.
3. API integration: create/update/list/get/reload, pagination, CAS,
   lossless private detail full-PUT round trip, redacted list, exact
   sourceVersion history/cursor isolation, idempotency/path conflict,
   cross-project and malformed UUID.
4. Reference upload tests: real JPEG/PNG/WebP, fake MIME, corrupt/truncated,
   SVG, pixel/size bomb, Unicode filename, Range 206/416, private storage and
   cleanup ambiguity.
5. Existing source/cut/editorial/approval/export suites без изменений expected
   behavior; manual save создаёт MANUAL provenance, legacy read совместим.
6. Race tests: semantic-equivalent URL concurrent create/update; old alias
   reservation; upload → authorize → explicit CAS set-default; later auth/revoke
   меняет usability; profile → source context → prompt staleness без silent
   downstream rebind.
7. Contract fixture будущего worker gate доказывает: queued job, для которого
   policy/context стал stale до pre-dispatch CAS, не вызывает fake provider;
   AI-likeness approval становится stale после revoke, manual approval остаётся
   current. Runtime job type в первом slice не добавляется.
8. Explicit assertion: Stage 2B action не создаёт `PipelineJob`/`JobAttempt` и
   не обращается к Redis/provider.
9. OpenAPI generation + drift API/web, strict TypeScript, lint, format, build и
   `git diff --check`.
10. Independent reviewer читает настоящий diff и воспроизводит минимум URL
    uniqueness, private round-trip/list redaction, exact source-version history,
    set-default/revoke, cross-project, concurrent CAS, upload cleanup и
    manual-path regression.

После CLEAN и owner-approved rollout выполнить browser smoke:

```text
manual Stage 2 package остаётся доступным
→ создать CreatorProfile с official HTTPS URL
→ list скрывает private notes; detail/reload возвращает их без потери
→ эквивалентный official URL не создаёт duplicate profile
→ загрузить reference: всё ещё запрещён
→ явно CLEARED: всё ещё не default
→ explicit CAS set-default: разрешён exact reference/auth revision
→ связать exact sourceVersion context и READY cut prompt
→ новая profile revision делает downstream chain stale без silent rebind
→ обновить context/prompt; full reload/project switch восстанавливает revisions
→ revoke reference: likeness снова запрещён
→ сохранить ручную metadata/thumbnail revision
→ preview/approval/export работают как раньше и показывают MANUAL/MANUAL
```

Success evidence включает exact IDs/revisions, HTTP outcomes, anonymous object
denial, отсутствие новых jobs, screenshots/visible state и команды checks.

## Rollout

1. Сохранить forward-compatible API build с `AI_CONTEXT_ENABLED=0`.
2. Read-only проверить active jobs, migration status и backup/rollback target.
3. Применить additive migration; provider secrets не добавлять.
4. Запустить API admission-off и пройти existing manual smoke.
5. Развернуть frontend, включить только `AI_CONTEXT_ENABLED=1` и выполнить
   bounded browser smoke выше.
6. Не начинать Stage 2B-2 до final CLEAN этого slice и обновлённого handoff.

## Rollback

Выключить `AI_CONTEXT_ENABLED`, скрыть UI/routes и вернуть сохранённый
forward-compatible admission-off API. Additive rows/objects остаются private и
readable для forward fix; down migration, deletion reference assets и rewrite
legacy revisions запрещены. Existing manual Stage 1/2 routes, jobs, approvals и
exports продолжают работать независимо.

## Definition of Done

Slice готов только когда backend, frozen OpenAPI и frontend последовательно
получили independent `CLEAN`; migration/rollout выполнены в безопасном порядке;
real browser smoke воспроизводится; documentation/handoff обновлены; rollback
проверен. Наличие таблиц без пользовательского create → bind → reload результата
не считается завершённым vertical slice.
