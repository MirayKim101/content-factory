# ADR-011: Private production runtime packaging

- Статус: Content Factory architect-approved for bounded
  implementation/preparation; independently reviewed; deployment not
  approved
- Дата: 2026-10-03
- Автор решения: Content Factory architect
- Independent reviewer: Content Factory reviewer, CLEAN, 2026-10-03
- Owner authority: autonomous production preparation is authorized;
  deployment, external access and credentials are not approved

## Проблема и доказательства

Текущий `infrastructure/compose.yaml` запускает PostgreSQL, Redis, MinIO и
независимые worker-роли, но не содержит deployable NestJS API, Nuxt web runtime
или закрытый production edge. Локальные процессы на `127.0.0.1:3001` и
`127.0.0.1:3100` доказали продуктовые сценарии, но не являются воспроизводимым
production runtime. Порт `3000` принадлежит другому проекту и не входит в
Content Factory.

ADR-001 уже выбрал один same-origin edge: browser использует относительный
`/api/v1`, а инфраструктура потоково передаёт этот фиксированный route в
приватный NestJS API без Nitro BFF, CORS и прикладной логики в proxy. Архитектура
также требует независимые frontend/backend, PostgreSQL как authoritative state,
Redis/BullMQ как disposable coordination и отдельные restart-safe workers.

Production audit дополнительно установил два незакрытых gate:

- существующие PostgreSQL restore proofs не доказывают совместное восстановление
  matching PostgreSQL metadata и MinIO media;
- complete source/build и production-classified `pnpm audit` остаются красными
  из-за двух high advisories без опубликованного исправления:
  `node-forge` `GHSA-86w9-cpqp-85rv` и `braces`
  `GHSA-vfj7-8cjw-p6xm`.

Будущий Caddy runtime не должен содержать Nuxt build graph, но отсутствие этих
пакетов в final image не отменяет риск source/build pipeline. Source gate и
artifact/runtime gate являются отдельными обязательными условиями, а не
взаимозаменяемыми доказательствами.

## Текущие ограничения

- Nuxt 4 остаётся client-side SPA; SSR, Nitro BFF и application JWT не
  вводятся.
- NestJS остаётся независимым versioned REST API; OpenAPI и generated client
  остаются единственным browser contract.
- Единственный browser API prefix — фиксированный `/api/v1/**`; upstream нельзя
  выбирать из request data.
- API, PostgreSQL, Redis, MinIO, MinIO console и workers нельзя публиковать на
  host interfaces.
- До выбора владельцем server/domain/VPN/access-proxy нельзя настраивать
  внешний доступ, TLS origin, DNS, firewall или provider-owned port.
- Production использует `DEPLOYMENT_PROFILE=other` и
  `SOURCE_AUTHORIZATION_POLICY=manual`. Local-auto evidence не разрешает
  playback, processing или download.
- Все Stage 3 write/admission flags остаются fail-closed. Twitch, external AI,
  YouTube/TikTok credentials и реальная публикация не разрешены этим ADR.
- Long-running media work остаётся в независимых workers; HTTP request не
  выполняет FFmpeg, AI или publication work.
- Object storage authoritative для media; worker/API disks являются только
  bounded scratch. PostgreSQL authoritative для business/job state; Redis не
  становится recovery source.
- Образы и package graph должны быть воспроизводимо закреплены. Нельзя
  использовать advisory allowlist, `ignore-unfixed`, снижение audit threshold
  или unsupported major transitive override.
- Protected external directories и associated resources полностью исключены из
  build context, CI, runtime и deployment work. Под «пользовательскими файлами»
  здесь понимаются только uncommitted/ignored working-tree versions, локальные
  editor files, credentials и data, а не обязательный committed product source.
- Image source context создаётся из exact reviewed Git commit object, а не из
  mutable working tree. Он включает allowlisted committed source closure и
  исключает uncommitted versions, `.idea`, root `package-lock.json`, `.env*`,
  local data и остальные untracked/ignored files. Нельзя молча исключать
  committed feature module только потому, что у того же path есть защищённая
  working-tree версия.
- Frozen preparation baseline commit
  `65e7e2ba67fefafc4221d1cc2751bfdd180d68a8` содержит обязательные
  `apply-ai-thumbnail.ts`, `save-editorial-package.ts` и
  `prisma-editorial.repository.ts` как blobs `bb4bd406b421`, `25da5afbdfa1` и
  `793c54656a5d`. На момент independent review текущий `HEAD`
  `70dee37891d95bc7494c4a926cd8c6ea321426de` сохранял те же blobs
  для этих трёх paths. Только эти committed versions могут попасть в
  bounded context; их pending working-tree versions нельзя читать через
  filesystem, копировать, stage, reset или overwrite в рамках packaging
  slice.

## Варианты

### Вариант A: сохранить только текущий local runtime

Сохраняет минимальную операционную стоимость и не создаёт нового ingress, но не
закрывает P0: API/web отсутствуют в Compose, edge/TLS/access boundary не
воспроизводимы, final runtime images и их SBOM/audit отсутствуют. Вариант
допустим как rollback и как режим разработки, но не как production runtime.

### Вариант B: отдельные API targets и один static Caddy web-edge

NestJS получает независимые `api-runtime` и `api-migrate` image targets из
одного source revision. Nuxt собирается в build stage как статическая SPA, а
final `web-edge` image содержит только закреплённый Caddy runtime, статические
assets и инфраструктурную конфигурацию. Caddy обслуживает SPA и потоково
направляет только `/api/v1/**` в private `api:3001`.

Compose публикует только `web-edge` как `127.0.0.1:8080`; все остальные порты
остаются container-internal. Внешний private access позже может принадлежать
host-level VPN/access proxy, который завершает TLS на своём provider-owned port
и направляет запросы в loopback `127.0.0.1:8080`. Этот access layer этим ADR не
выбирается и не настраивается.

Вариант сохраняет утверждённый same-origin contract, не добавляет Node proxy-hop
для больших файлов и оставляет простой scale path: API и workers можно
реплицировать независимо, а web-edge позже разделить только при измеримой
операционной необходимости. Выбран этот вариант.

### Вариант C: отдельные Nuxt/Nitro web и edge containers

Позволяет runtime public config без rebuild, но добавляет Node/Nitro process и
второй proxy/runtime hop, расширяет production dependency graph и усложняет
health, patching и streaming failure modes. Текущая SPA не требует server
rendering или BFF, поэтому стоимость выше пользы. Отклонён.

### Вариант D: public edge или application authentication

Public Caddy с domain/TLS, external access proxy, cookie/JWT authentication и
public Twitch webhook являются отдельными operating-model decisions. Без
выбранных domain, identities, ACL, secrets, firewall и owner approval такой
вариант не может быть fail-closed. Отложен; этот ADR не разрешает public bind.

## Решение

### Images и процессы

1. `api-runtime` — минимальный production NestJS runtime без build toolchain и
   migration CLI. Он запускается non-root, с read-only root filesystem,
   dropped capabilities, `no-new-privileges`, bounded PID/CPU/memory, graceful
   `SIGINT`/`SIGTERM`, local log rotation и отдельным writable upload scratch.
   Его dependency closure создаётся отдельным frozen pnpm install с
   `--prod --no-optional` и scoped API dependency filter. Closure содержит
   `@prisma/client` и `@prisma/adapter-pg`, но не `prisma`,
   `@prisma/engines`, `@prisma/dev`, TypeScript, `tsx`, test/lint tools или
   build-stage `node_modules`. Ручное удаление пакетов из установленного graph
   не допускается; final inventory и runtime smoke доказывают closure.
   Выбранный BullMQ Redis backend делает `ioredis` runtime requirement,
   несмотря на optional peer metadata BullMQ. Поэтому API объявляет direct
   pinned production dependency `ioredis@5.11.1`; `--no-optional` не должен
   полагаться на auto-installed optional peer. Root peer-resolution rewrite,
   `packageExtensions` и transitive override для этой связки не допускаются.
2. `api-migrate` — независимый one-shot target из того же commit/lockfile. Он
   использует отдельный workspace dependency graph с direct pinned
   `prisma@7.10.0` и `dotenv@17.4.2`, минимальным migration-only config и
   единственными canonical `apps/api/prisma/schema.prisma` + committed migrations.
   Config читает только injected `DATABASE_URL`; он не импортирует contracts,
   Nest application или полный API environment module. Prisma CLI принадлежит
   build/migration graph, а не API runtime graph. Target не слушает HTTP port и
   завершается non-zero при любой
   migration/configuration error. `api-runtime` не стартует до его successful
   completion. Использовать весь API dev graph или вручную копировать CLI из
   build-stage `node_modules` запрещено. Существующий API `devDependency`
   `prisma@7.10.0` сохраняется для repository DB scripts и CI; его исключает из
   final API closure именно `--prod`, а не удаление из API manifest.
3. `web-edge` — multi-stage image. Node/pnpm/Nuxt существуют только в build
   stage. Final image использует проверенный Caddy version, закреплённый digest,
   запускается non-root/read-only и содержит только SPA assets, Caddy binary и
   edge configuration. В нём нет Node, pnpm, Nuxt/Nitro runtime, source tree или
   `node_modules`.
4. Существующие worker roles остаются независимыми. Base private runtime
   запускает только роли, необходимые ручному горизонтальному pipeline.
   External AI, Twitch, vertical и publication roles отсутствуют в default
   profile либо остаются non-default и независимо hard-disabled.

### Routing и сеть

- `web-edge` является единственным host-published service:
  `127.0.0.1:8080` к внутреннему Caddy listener. Нельзя подменять loopback на
  `0.0.0.0`, wildcard, auto-assigned host port или port `3000`.
- `/api/v1/**` имеет один статический upstream `api:3001` и сохраняет method,
  path/query, `Idempotency-Key`, request ID, content/range headers, status,
  content type и safe error body. Client-provided `X-Forwarded-*` не является
  trusted input.
- Request buffering выключен; response buffering не должен превращать media в
  full-object memory buffer. Edge upload limit немного выше
  `API_MAX_UPLOAD_BYTES`, чтобы NestJS формировал штатный JSON `413`. Proxy
  deadlines не короче документированных upload/finalization deadlines.
- Все остальные paths обслуживают immutable SPA assets с client-router fallback
  и корректной cache policy: hashed assets immutable, `index.html`
  revalidated.
- API и web-edge разделяют только edge network. API дополнительно подключён к
  private backend network с PostgreSQL/Redis/MinIO/workers. Stateful services и
  их consoles не имеют production `ports` mapping.
- Future host-level VPN/access proxy должен владеть TLS/public-private ingress
  port и проксировать только loopback listener. Его provider, domain, ACL и TLS
  не входят в implementation approval этого ADR.

### Configuration и admission

- API и workers получают `DEPLOYMENT_PROFILE=other`,
  `SOURCE_AUTHORIZATION_POLICY=manual`; API слушает container interface только
  внутри private network.
- `PUBLISHING_ENABLED`, `YOUTUBE_PUBLISHING_ENABLED`,
  `TIKTOK_PUBLISHING_ENABLED`, `TWITCH_INGESTION_ENABLED`,
  `TWITCH_VOD_AUTO_INGEST_ENABLED`, `TWITCH_VOD_MEDIA_GATEWAY_ENABLED`,
  `VERTICAL_RENDER_ENABLED`, `CLIP_GENERATION_ENABLED` и остальные external
  AI write gates фиксированы в `0` для этого runtime и не могут быть случайно
  включены generic `.env` substitution.
- Production Compose не передаёт OAuth, Twitch, OpenAI, publication-session или
  target-platform credentials. PostgreSQL/Redis/S3 runtime credentials
  необходимы, но их values, storage и rotation требуют отдельного human
  deployment decision.

### Storage, health и bounded resources

- API upload scratch и worker scratch имеют отдельные bounded writable mounts,
  измеренный capacity threshold, cleanup/reconciliation и admission ниже
  safety reserve. Large media нельзя размещать в unbounded RAM tmpfs.
- Persistent PostgreSQL и MinIO data должны иметь явно выбранные mount,
  capacity, retention и backup policy до deployment. Redis persistence не
  заменяет PostgreSQL recovery.
- `/api/v1/health` остаётся dependency-free liveness. Отдельная bounded
  readiness проверяет обязательные PostgreSQL, Redis и object-storage
  dependencies с generic `200`/`503`, без credentials или internals в body.
- Caddy имеет отдельную static liveness; worker readiness создаётся только после
  успешной role initialization и удаляется до shutdown drain.
- Compose dependency order использует healthy/service-completed conditions, но
  healthchecks не подменяют application reconciliation и backup evidence.

### Supply chain и CI gates

- Build provenance фиксирует commit SHA/tree и Dockerfile/lockfile digests.
  Context materialизуется из Git object database; build из mutable checkout,
  даже если Docker ignore выглядит закрытым, не является promotion evidence.
  Allowlist closure проверяется против imports/TypeScript dependency graph
  выбранного commit. Packaging не stage/reset/overwrite защищённые pending
  working-tree paths.
- Dockerfile frontend, base images и promoted application images закрепляются
  version + immutable digest; install использует committed lockfile и
  `pnpm install --frozen-lockfile`.
- В pinned pnpm `10.34.5` dependency lifecycle scripts управляются
  fail-closed через version-scoped `allowBuilds`: exact `esbuild@0.28.2`,
  `prisma@7.10.0`, `@prisma/engines@7.10.0` и `vue-demi@0.14.10` имеют
  value `true`; exact `@scarf/scarf@1.4.0` и `msgpackr-extract@3.0.4`
  имеют value `false`. `strictDepBuilds` остаётся `true`. Generic rebuild,
  `dangerouslyAllowAllBuilds` и любой нерассмотренный lifecycle script запрещены
  и должны завершать install non-zero. Prisma preinstall и engine postinstall
  выполняются только в builder.
- Exact approval `vue-demi@0.14.10` ограничен reviewed lifecycle для
  locked `vue@3.5.42`. Postinstall читает `Vue.version`, выбирает
  Vue 3 branch и копирует только package-local `lib/v3/index.cjs`,
  `lib/v3/index.mjs` и `lib/v3/index.d.ts` в corresponding `lib/index.*`.
  Reviewed code не использует network, external processes, credentials или
  project files. Exact `true` устраняет подтверждённый pnpm `10.34.5`
  raw-name bug для versioned `false`, сохраняя version-closed approval и
  unknown-script failure. Любое изменение exact version, integrity, peer Vue
  или side-effect boundary требует повторного review.
  Bundled Vue 3 parity доказана clean fixture: `lib/index.cjs`,
  `lib/index.mjs` и `lib/index.d.ts` byte-identical с corresponding
  `lib/v3/index.*` до postinstall; CJS возвращает `isVue3=true` и
  `isVue2=false`. В текущем graph approved postinstall функционально
  является no-op package-local file copy; exact `true` нужен для
  корректной strict policy pinned installer. Acceptance обязательно
  требует cold empty-store frozen install, full-source checks, web typecheck,
  browser tests и production web build.
- Exact deny `msgpackr-extract@3.0.4` одобрен как отключение optional
  native string-decoding acceleration. Vendor `msgpackr@2.0.5`
  объявляет addon optional, ловит ошибку его загрузки и сохраняет pure-JS
  decoder; vendor README описывает addon как optional performance boost.
  Acceptance требует independent review этого exact vendor fallback и real final
  API/BullMQ smoke без native addon. Если fallback или interoperability не
  доказаны, preparation останавливается; менять value на `true` без
  отдельного review нельзя.
- Source/build audit и production-classified audit выполняются отдельно с
  threshold `moderate`; оба обязаны завершиться exit code `0`. Исключения,
  allowlist, `continue-on-error`, `ignore-unfixed` и threshold lowering
  запрещены.
- Каждый final OCI image получает digest-bound SBOM, provenance и artifact
  scan. Moderate/high/critical finding блокирует promotion даже при зелёном
  source audit. Clean final Caddy image не отменяет красный Nuxt build graph.
- До устранения `GHSA-86w9-cpqp-85rv` и `GHSA-vfj7-8cjw-p6xm` разрешены только
  implementation, tests и non-promotable diagnostic images. Публикация или
  promotion release image запрещены.
- CI не получает deployment credentials, не обращается к production data и не
  публикует service ports. Generated-client/source gate является необходимым,
  но недостаточным доказательством runtime readiness.
- На 2026-10-03 upstream Caddy `2.11.7` опубликован как исправление regressions
  `2.11.6`, включая обрыв stream после одной минуты, но официальный
  `caddy:2.11.7-alpine` ещё отсутствует. `2.11.6`, mutable `latest`/`alpine` и
  самостоятельная подмена release binary не принимаются. Web-edge packaging
  остаётся на hold до появления official exact tag, проверки manifest digest и
  long-stream smoke; независимая API/worker preparation может продолжаться.

## Последствия

### Поставка продукта

Появляется простая single-host production packaging boundary без изменения
REST contract, module boundaries или worker state machines. Frontend build и
backend остаются независимыми artifacts. Static public configuration
закрепляется в web image; её изменение требует rebuild, а server-authoritative
capability/admission checks остаются обязательными.

### Данные и миграции

Сам ADR не добавляет schema migration и не переписывает records/media.
`api-migrate` применяет только committed Mac-baseline Prisma migration chain.
Он может работать только с новой пустой Content Factory DB/object namespace
или с independently verified matching PostgreSQL + MinIO restore. Неизвестная
provenance, alternate WSL migration line, изменение `_prisma_migrations` или
несогласованное восстановление только одной стороны являются hard stop.

### Эксплуатация и наблюдаемость

Оператор получает immutable image digests, health/readiness, bounded logs,
graceful stop и воспроизводимый Compose topology. Полноценные monitoring,
alerting, backup schedule, restore exercise, host patching и private-access ACL
остаются обязательными deployment facts, а не автоматически решёнными этой
упаковкой.

### Безопасность

Default runtime имеет один loopback ingress, не содержит app JWT и не доступен
из внешней сети. API/data ports, Stage 3 writes и provider credentials закрыты.
Multi-stage web image уменьшает runtime attack surface, но build-tool
vulnerabilities продолжают блокировать promotion. Manual exact-source
authorization и provider-owned ports сохраняются.

### Стоимость разработки и AI-агентов

Добавляются два API targets, один static web-edge target, Compose/edge config и
artifact evidence. Это меньше surface и review cost, чем отдельные Nitro web и
edge runtimes. Новых paid providers нет; фактическая стоимость host, private
access, storage и backups неизвестна до human deployment facts.

### Долгосрочная поддержка

Digest pinning требует регулярных reviewed updates и повторных scans. При
появлении измеримой потребности web-edge можно разделить или добавить
application auth отдельным ADR, не меняя `/api/v1` contract и business state.

## Миграция

1. Добавить scoped API runtime/migrate targets, static Nuxt/Caddy web-edge,
   закрытые build contexts и standalone private-production Compose, не меняя
   текущий local runtime.
2. Проверить official versions/changelogs/compatibility, закрепить все base
   images и Caddy digest, frozen lockfile и build provenance.
3. Запустить полный source gate. Пока оба unresolved high остаются, сохранить
   images только как non-promotable test evidence и остановить rollout.
4. После зелёных source audits построить final images, создать SBOM и выполнить
   image scans без исключений. Проверить отсутствие Node/Nuxt/build graph в
   final web-edge и production-only closure в API/worker images.
5. В disposable environment применить все migrations через `api-migrate`,
   запустить API/workers/web-edge и воспроизвести manual upload -> explicit
   authorization -> background cut -> status -> Range playback/download,
   controlled failure, duplicate replay, restart и Redis-loss recovery.
6. Доказать backup/restore PostgreSQL и matching MinIO objects как одну recovery
   unit либо выбрать новую пустую DB и отдельный object namespace. Записать
   checksums, migration status, RPO/RTO и restore evidence.
7. Получить от владельца target host/architecture/resources, persistent paths,
   registry/image transport, secrets mechanism, private-access provider,
   identities/ACL, TLS/port ownership, firewall, monitoring/alerts,
   maintenance window и rollback authority.
8. Только после отдельного deployment approval использовать exact reviewed
   image digests. Stage 3 остаётся disabled; любой provider rollout имеет свой
   credentialed canary и approval.

## Rollback

До deployment rollback — удалить или не использовать подготовленные runtime
artifacts; current local Compose и ручной workflow остаются неизменными.

После отдельно одобренного deployment сначала закрыть edge admission и
остановить новые requests, затем graceful drain API/workers и вернуть previous
reviewed image digests/Compose configuration. Static web-edge откатывается
заменой image digest. Prisma down migrations автоматически не выполняются:
previous API запускается только после rollback-compatibility check. Если schema
или data требуют restore, PostgreSQL dump и matching MinIO object snapshot
восстанавливаются вместе в отдельную namespace и переключаются после проверки;
нельзя откатывать только metadata или только media. Redis можно пересоздать, а
PostgreSQL reconciliation восстанавливает runnable work.

Stage 3 admission и provider credentials при rollback остаются выключенными.
Durable intents/history не удаляются. Внешних publication effects в этом
runtime быть не должно.

## Критерии успеха

1. API runtime и one-shot migrate targets строятся из одного exact commit и
   lockfile, имеют отдельные минимальные final images и immutable digests.
2. Final web-edge содержит Caddy + static SPA, но не содержит Node, pnpm,
   Nuxt/Nitro runtime, source tree, credentials или `node_modules`.
3. `docker compose config` fail-closed при отсутствии required values и
   показывает единственный host mapping `127.0.0.1:8080`; port `3000`, API,
   PostgreSQL, Redis, MinIO и MinIO console не опубликованы.
4. Browser использует один origin и только `/api/v1/**`; CORS не нужен. Edge
   сохраняет streaming, Range, idempotency/request headers, status и safe error
   semantics; spoofed forwarding headers не становятся trusted.
5. Multipart memory зависит от buffer/chunk/concurrency, а не от full media
   size. `413`, disconnect, upstream `502/504`, Range `206/416` и scratch
   cleanup воспроизводятся контролируемо.
6. API liveness, dependency-aware readiness, web-edge liveness и readiness всех
   enabled worker roles проверены при startup, dependency loss и graceful
   shutdown без утечки configuration details.
7. Containers работают non-root/read-only, с dropped capabilities,
   `no-new-privileges`, bounded resources, writable mounts только по назначению
   и bounded log rotation.
8. Production profile/manual source authorization проверены API и workers;
   local-auto evidence fail-closed для playback, cuts, dispatch и download.
9. Все Stage 3/external AI/publishing gates равны `0`, credentials отсутствуют,
   external network writes не происходят, manual horizontal path остаётся
   рабочим.
10. Formatting, lint, typecheck, unit/integration/recovery tests, OpenAPI drift,
    fresh migrations, builds, Compose validation и browser/container smoke
    проходят на pinned toolchain.
11. Complete source/build и production-classified audits возвращают `0` без
    исключений. Пока два unresolved high существуют, критерий не выполнен и
    promotion остаётся запрещённым.
12. Каждый final image имеет привязанные к digest SBOM/provenance и clean
    artifact scan на том же severity threshold; clean artifact не подменяет
    source gate.
13. Fresh-empty data path либо paired PostgreSQL + MinIO backup/restore доказан
    в disposable environment; migration lineage, checksums и rollback evidence
    сохранены. Redis loss не теряет authoritative state.
14. Manual end-to-end smoke через edge создаёт один logical intent/artifact при
    duplicate/lost-response replay, переживает API/worker restart и
    восстанавливает runnable work после Redis loss.
15. Independent reviewer проверяет real diff, final image contents, effective
    Compose ports/networks/config, audits, smoke, backup proof и rollback.
16. External private access, server/domain/VPN, TLS/ACL, credentials и real
    publishing остаются явно `not configured / not approved` до отдельного
    human deployment decision.
17. Build evidence называет exact commit/tree; API source в context совпадает с
    committed blobs этого commit. Uncommitted/ignored content, `.idea`, root
    `package-lock.json`, `.env*` и local data отсутствуют, а protected pending
    paths не staged/reset/overwritten.
18. `api-runtime` inventory подтверждает direct `ioredis@5.11.1` и
    production-only graph без Prisma CLI, engines/dev tooling и случайного
    optional-peer pollution. `api-migrate` отдельно содержит pinned
    `prisma@7.10.0`, `dotenv@17.4.2`, required engine и canonical migration chain;
    его config читает только `DATABASE_URL` и не импортирует полный API
    environment module. Оба targets проходят startup/config smoke на Node 24,
    а migration target не запускает HTTP.
19. Web-edge target не считается подготовленным, пока official
    `caddy:2.11.7-alpine` (или более новый reviewed fix release) не доступен и не
    закреплён immutable multi-architecture digest; stream длительностью больше
    минуты и large upload/download проходят controlled smoke.
20. Frozen cold-store install завершается non-zero при любом
    lifecycle script вне exact version-scoped `true` entries; exact `false`
    entries не выполняются. `vue-demi@0.14.10` postinstall изменяет
    только три reviewed package-local `lib/index.*`, выбирает Vue 3 и не
    создаёт network или external-process activity. Full source/web typechecks,
    browser tests и production web build проходят после exact lifecycle. Final
    runtime images не содержат builder lifecycle state или package-manager cache. Final API
    inventory не содержит
    `msgpackr-extract`, его platform packages или
    `node-gyp-build-optional-packages`; pure-JS MessagePack round-trip и real API-to-BullMQ
    dispatch/consume smoke проходят после independent vendor fallback review.

## Promotion и deployment gate

Implementation/preparation считается разрешённым только в пределах этого ADR.
Image promotion требует одновременно:

1. зелёных complete-source и production-classified audits без исключений;
2. clean digest-bound scans/SBOM/provenance всех final images;
3. успешных functional, failure, restart и recovery checks;
4. paired PostgreSQL/MinIO restore proof или подтверждённого fresh-empty target;
5. independent review.

Deployment дополнительно требует human facts и отдельного owner approval для
host, capacity, data target, registry, secrets, private access, identities/ACL,
TLS/ports, firewall, monitoring, backup schedule, maintenance и rollback.
Отсутствие любого факта означает fail-closed: deployment не выполняется и
loopback не заменяется public bind.

На дату ADR оба source audits остаются красными из-за
`GHSA-86w9-cpqp-85rv` и `GHSA-vfj7-8cjw-p6xm`; поэтому promotion и deployment
запрещены независимо от будущего clean Caddy runtime scan.

## Решение tech lead

Одобрен вариант B для bounded implementation и preparation evidence. Это
архитектурное одобрение не является разрешением на image promotion, production
deployment, внешний доступ, credentials, Twitch ingestion, external AI или
реальную публикацию. Promotion и deployment остаются fail-closed до выполнения
всех критериев и отдельного human deployment approval.
