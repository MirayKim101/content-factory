# Stage 2B-6 — integrated editorial review and economics

Статус: frozen; architecture approved 2026-09-24

Дата фиксации: 2026-09-24

## Цель

Завершить pre-Twitch Stage 2B одним authoritative review path, в котором
оператор видит независимое происхождение metadata и thumbnail, citations,
freshness, безопасность и прямую AI-стоимость, после чего подтверждает exact
current revision и получает детерминированный ZIP package. Полностью ручной путь
остаётся работоспособным при выключенных AI admission flags.

Этот срез не добавляет внешнего provider, likeness generation, Twitch,
vertical clips, publication или analytics.

## Версионирование и совместимость

Новые записи используют:

- `editorial-review-candidate-v2`;
- `human-horizontal-approval-v2`;
- `approval-economics-v2`;
- `operator-attention-v2`;
- `editorial-export-zip-v2`;
- `editorial-export-manifest-v2`;
- `editorial-metadata-v2`.

Система продолжает читать и безопасно завершать исторические:

- `manual-horizontal-approval-v1`;
- `editorial-export-zip-v1`;
- `editorial-export-manifest-v1`.

Смысл v1 contracts не меняется. Existing v1 rows не переписываются. Новый v2
approval не маскируется под v1, а worker умеет claim/finalize как v1, так и v2
exports. Откат отключает новое admission, но сохраняет historical v1/v2 rows и
private artifacts.

## Authoritative review model

`GET /api/v1/pipeline-jobs/:cutJobId/editorial-review` остаётся единственным
authoritative read model. Для current revision он дополнительно возвращает
`reviewContractVersion = editorial-review-candidate-v2`, server-derived
`workflowMode` и summary отдельно для `METADATA` и `THUMBNAIL`:

- `mode`: `MANUAL`, `AI_ASSISTED` или `MIXED`;
- exact basis version и применимые intent/set/candidate identities;
- bounded citations с server-owned IDs, HTTPS URL и versioned
  `public-citation-text-v1` (`title <= 500`, `publisher <= 300`),
  `publishedAt` и `accessedAt`;
- research `searchedAt`, `freshUntil` и current freshness state;
- image safety decision и likeness mode;
- direct AI cost в integer USD microunits, cost basis version и incomplete
  reasons;
- combined direct AI cost для exact current editorial revision.

`workflowMode` вычисляет только сервер: `MANUAL`, если обе компоненты manual;
`AI_ASSISTED`, если обе exact AI-assisted; любая другая комбинация даёт
`MIXED`. Review также возвращает `economicsPreview`: существующие processing
metrics, assistance timing при наличии и direct provider cost с
`currency = USD`, `unit = MICRO`.

DTO не раскрывает object keys, raw provider payload, transcript/frame bytes,
credentials, private prompts или private image bytes. Legacy/manual provenance
даёт честный `MANUAL` summary и нулевую AI-стоимость.

Review UI показывает metadata и thumbnail как независимые компоненты, а не
один общий AI badge. Оператор может сравнить предложение с current content,
открыть citations, увидеть freshness/cost и выполнить существующие regenerate,
apply/edit/manual actions. UI не вычисляет provenance или стоимость сам и не
разрешает клиенту объявить `AI_ASSISTED`.

## Exact approval v2

V2 request сохраняет route и принимает только authoritative candidate identity
и измерение внимания:

```json
{
  "approvalContractVersion": "human-horizontal-approval-v2",
  "editorialRevision": 3,
  "candidateFingerprint": "sha256:...",
  "attention": {
    "schemaVersion": "operator-attention-v2",
    "preparationForegroundMs": 120000,
    "finalReviewForegroundMs": 45000
  }
}
```

При создании v2 approval API в той же serializable transaction повторно
проверяет current editorial/render/rights chain и сохраняет immutable one-to-one
economics snapshot плюс ровно две component snapshot rows:

- exact editorial revision и её metadata/thumbnail provenance;
- exact research intent/snapshot/suggestion set/variant/citation identities,
  когда они применимы;
- exact image intent/candidate/safety/likeness identities, когда они применимы;
- context/evidence lineage, присутствующую в component provenance;
- metadata, thumbnail и combined direct AI cost в USD microunits;
- versioned cost basis и explicit incomplete reasons;
- canonical snapshot fingerprint.

`EditorialApprovalComponentSnapshot` хранит `approvalId`, component, exact
`EditorialComponentProvenance` ID, mode/basis, nullable exact research
intent/suggestion set либо image intent/candidate, direct cost/basis и имеет
unique `(approvalId, component)` с component-specific DB checks.

`EditorialApprovalEconomicsV2` one-to-one хранит schema/workflow mode,
preparation/final-review/total operator attention, metadata/evidence/thumbnail
USD-microunit costs, server-derived total, basis versions, nullable assistance
timing и incomplete reasons. Snapshot fingerprint входит в v2
candidate/approval identity. Approval metrics v1 сохраняются без изменения.
Public API/OpenAPI публикует этот economics snapshot как закрытый typed DTO;
`assistanceTiming` остаётся только `null`, пока отдельный versioned timing
contract не определён, поэтому произвольный JSON не проходит currentness.
Общая economics view различает operator attention,
pipeline time, Stage 2 direct provider cost и Stage 2B AI direct cost, не
складывая разные currencies/units в одно число.

Клиент не передаёт mode, provenance ID или cost. Для v2 server проверяет ровно
одну provenance row каждого component, component-specific exact READY lineage,
cross-project/cross-cut identities, known cost basis и совпадение generated
thumbnail asset bytes. Подтверждается только реально использованное evidence:
transcript/research для AI/MIXED metadata, image intent/candidate для generated
thumbnail и frames только если adapter действительно их использовал.

Новый v1 approval разрешён только для `MANUAL/MANUAL`; AI/MIXED даёт
`EDITORIAL_PROFILE_UNSUPPORTED`. Historical v1 остаётся читаемым, но
historical AI-derived v1 не допускается к новому current export.

Тот же idempotency key и exact v2 tuple возвращают один approval. Изменение
snapshot fingerprint, attention, render или любой exact identity даёт
controlled conflict. Concurrent different keys сходятся на одном logical v2
approval.

## Invalidation

- Успешный AI apply, ручное сохранение или редактирование current component
  создаёт новую `EditorialPackageRevision`; прежний approval становится
  `STALE` через существующий exact revision gate.
- Preview, создание неприменённого suggestion/candidate, provider failure или
  regenerate без успешного apply не меняют current revision и не инвалидируют
  approval.
- Currentness проверяется на review, export admission, worker claim,
  finalization и download.
- Existing likeness-rights gates сохраняются. Этот срез не включает realistic
  likeness generation.

## Export manifest v2

Export contract server выбирает из approval contract: v2 approval создаёт
только v2 export, клиент не выбирает несовместимую пару. Новый v2 export
сохраняет прежние пять ZIP entries и порядок:

1. rendered video;
2. thumbnail;
3. `metadata.txt`;
4. `metadata.json` с `editorial-metadata-v2`;
5. `manifest.json`.

`manifest.json` с `editorial-export-manifest-v2` сохраняет v1 exact lineage и
entry checksums/sizes, а также bounded immutable approval snapshot:

- независимые metadata/thumbnail modes и exact component identities;
- citations/freshness summary;
- image safety/likeness summary;
- operator attention и processing metrics;
- metadata/thumbnail/combined AI direct cost и cost basis/incomplete reasons.

Manifest также фиксирует exact recipe/render/media identities, реально
использованные transcript identity/checksum и image safety decision. Он не
включает transcript text, citation excerpts, prompts, notes или reference
declarations. Checksum scope остаётся прежним: четыре payload entries, без
manifest self-hash и outer ZIP. JSON serialization, field order и trailing
newline фиксированы тестом.

Manifest не содержит signed/private URLs, object keys, raw provider responses,
private evidence bytes, credentials или неограниченный operator text. Export
остаётся streaming ZIP64, deterministic по exact approval snapshot и
restart-safe. V1 export создаёт manifest v1 без новых полей.

## Acceptance criteria

1. Manual/manual package показывает `MANUAL`/`MANUAL`, нулевую AI-стоимость,
   подтверждается v2 и экспортируется с manifest v2 при выключенных AI flags.
2. AI metadata + manual thumbnail показывает независимые
   `AI_ASSISTED`/`MANUAL`, exact citations/freshness/cost, подтверждается и
   экспортирует те же данные без private leakage.
3. Exact suggested metadata + generated thumbnail даёт workflow
   `AI_ASSISTED`; edited suggestion либо manual/AI combination даёт workflow
   `MIXED`. Отдельный pixel-edit thumbnail workflow в срез не входит.
4. Successful apply/edit после approval создаёт новую revision, делает approval
   и его export stale и требует нового explicit approval. Discarded preview и
   controlled provider failure approval не инвалидируют.
5. Same-key replay/concurrency создают по одному logical approval/export;
   cross-operation/cross-project/different-tuple reuse fail closed.
6. V1 approval/export rows читаются, v1 pending export может быть завершён
   обновлённым worker, а новые rows используют только v2.
7. Worker retry, lease loss, restart and duplicate delivery не создают второй
   READY artifact и не публикуют stale package.
8. Review/API/manifest не раскрывают private content/object keys/provider raw
   data; content остаётся доступен только через authorized bounded endpoints.
9. Integrated UI после reload восстанавливает authoritative component modes,
   citations/freshness/cost, attention draft/current approval и export state.
10. Operator-time benchmark фиксирует минимум один manual и один assisted run
    одинакового bounded сценария: measured attention, wall-clock processing,
    direct cost, итоговый mode и результат acceptance. Это evidence, не
    маркетинговое утверждение об экономии.
11. Forged, missing, cross-cut или stale provenance блокирует approval без
    partial writes; snapshot содержит ровно две component rows и одну economics
    row.
12. Attention total строго равен bounded preparation + final review; missing
    либо invalid значения не превращаются в ноль.
13. Local exact operations дают server-derived `0 microusd` с известными local
    basis versions.

## Необходимая проверка

- Prisma migration validate/status на disposable PostgreSQL;
- focused API integration для manual/AI/mixed review, approval snapshot,
  replay/concurrency, stale and private-data boundaries;
- focused worker integration для v1/v2 claim/finalize, retry/restart,
  deterministic manifest и duplicate prevention;
- focused web unit/component tests для independent modes, citations,
  freshness/cost, reload and invalidation messaging;
- generated OpenAPI drift, affected typecheck/lint/format;
- один real PostgreSQL + ContentFactory object storage E2E:
  manual approval/export и AI/mixed approval/export с ZIP checksum/manifest
  verification;
- independent real-diff review.

Повторный >4 GiB ZIP64 test не нужен, пока framing/archive writer не меняется;
обязателен deterministic manifest-v2 serialization regression.

## Rollout и rollback

1. Применить additive migration.
2. Развернуть worker, понимающий v1 и v2.
3. Развернуть API с `EDITORIAL_INTEGRATED_REVIEW_ENABLED=0` и остальным v2
   admission выключенным.
4. Развернуть generated client и UI.
5. Выполнить manual и assisted smoke, затем отдельно включить admission.

При rollback сначала отключить approval/export admission, дать уже claimed jobs
завершиться или истечь lease, затем откатить API/UI/worker binaries. Additive
tables/columns и historical v2 rows не удалять. Старый worker нельзя возвращать,
пока существуют claimable v2 export jobs.

## Implementation checkpoint — 2026-09-24

Срез реализован в рабочем дереве, но ещё не объявлен принятым: обязательны
independent real-diff review и два object-storage E2E из раздела проверки.

- additive migration хранит две exact component snapshot rows и одну economics
  row; nullable AI lineage защищён component/mode CHECK и составными FK;
- v2 допускает только revisions с ровно одной явной METADATA и THUMBNAIL
  provenance row. Legacy revision без этих rows остаётся совместимым только с
  v1 approval при выключенном integrated-review flag;
- API возвращает authoritative review v2, сам выводит component/workflow mode,
  нормализует bounded HTTPS citations до записи и сохраняет attention/cost;
- export admission сам выбирает v1/v2 из approval, worker claim/finalize
  проверяет exact pair и v2 rows, а manifest v2 содержит bounded component,
  economics и processing-metrics snapshot при прежних пяти ZIP entries;
- UI использует v2 только когда сервер сообщает включённый integrated-review
  admission; при default-off manual/manual продолжает прежний v1 путь.

Focused evidence:

- API approval/export/MinIO-policy plus migration-boundary fingerprint and
  exact citation-selection unit: 10 PASS;
- OpenAPI deterministic/stale artifact: 2 PASS;
- web approval/export/dialog/draft: 23 PASS;
- worker deterministic ZIP v1/v2: 5 PASS, opt-in >4 GiB case skipped;
- disposable PostgreSQL API legacy-fingerprint/currentness, historical
  AI-derived v1 export rejection, and real manual/MIXED/AI_ASSISTED v2
  repository create/replay/cross-cut/private-data gates: 5 PASS on Node 24.15;
- full disposable PostgreSQL worker repository harness: 12 PASS on Node 24.15,
  including exact v2 claim, composite-FK cross-revision rejection, copied
  economics tamper rejection, v1 AI/MIXED rejection, claim/finalize recovery
  and rollback admission-off subprocess;
- API/worker/web typecheck: PASS; Prisma validate/generate and OpenAPI
  export/client generation: PASS.

Post-review hardening binds every v2 snapshot to both the approved revision and
its exact component provenance with composite FKs. API and worker independently
recompute component/economics fingerprints and compare copied modes, lineage,
costs and basis versions. Approval additionally verifies the research,
transcript and thumbnail candidate against the reviewed cut; selected thumbnail
bytes/type/dimensions must equal the READY candidate asset. Historical v1
approvals keep their legacy fingerprint for read/currentness, but new export
admission and worker claim/finalize reject v1 revisions containing any
`AI_ASSISTED` or `MIXED` provenance.
Historical v1 same-key replay keeps the exact pre-migration canonical request
hash. V2 manifest JSON uses canonical recursive key ordering, so semantically
equal snapshot objects produce identical LF-terminated manifest and ZIP bytes.
V2 approval fingerprints also persist their serialization basis. Historical
rows use `editorial-approval-fingerprint-v2-date-object-legacy`; new approvals
use `editorial-approval-fingerprint-v2-iso8601`, which binds citation and
freshness timestamps as canonical ISO-8601 strings. A legacy row remains
current/exportable only while those stored dates exactly match its
authoritative research intent and citation rows.

### Scripted operator-attention proxy — 2026-09-24

Это только воспроизводимая проверка измерительного контракта на одинаковом
bounded integration fixture, а не реальный пользовательский benchmark и не
утверждение об экономии времени.

| Сценарий                           | Mode          | Preparation | Final review |   Total | Processing wall-clock proxy | Direct AI cost | Acceptance |
| ---------------------------------- | ------------- | ----------: | -----------: | ------: | --------------------------: | -------------: | ---------- |
| explicit manual/manual v2          | `MANUAL`      |      700 ms |       900 ms | 1600 ms |                   110000 ms |     0 microUSD | PASS       |
| research-assisted/manual thumbnail | `MIXED`       |      800 ms |      1200 ms | 2000 ms |                   110000 ms |    11 microUSD | PASS       |
| research + generated thumbnail     | `AI_ASSISTED` |      800 ms |      1200 ms | 2000 ms |                   110000 ms |    24 microUSD | PASS       |

UI fake-timer regression отдельно передаёт ненулевые `3000 ms` preparation и
`2000 ms` final review в v2 approval request. Реальный операторский benchmark
manual/assisted остаётся частью object-storage E2E gate; proxy выше нельзя
использовать для сравнения производительности или маркетинговых выводов.

Rollback остаётся admission-first: оставить
`EDITORIAL_INTEGRATED_REVIEW_ENABLED=0`, прекратить создание v2 approvals,
дождаться/погасить v2 export leases и не запускать старый worker, пока в БД есть
claimable `editorial-export-zip-v2`. Additive rows при rollback не удалять.
