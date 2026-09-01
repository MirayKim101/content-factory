# Content Factory — Architecture Baseline

Status: proposed baseline for MVP and subsequent scaling
Audience: owner, AI manager, architect/tech lead, engineers and reviewers

## 1. Architectural goals

Content Factory is a private internal application for obtaining long-form video, producing horizontal and vertical content, packaging it and publishing it to managed channels.

It is not a full-stack framework monolith. The Nuxt SPA and backend are fully independent applications connected through a versioned REST API and generated OpenAPI client. The backend does not render frontend pages or depend on Vue/Nuxt. Media and publishing workers are independent processes. This allows additional web, CLI or mobile clients without replacing backend business logic.

The MVP must use the same core pipeline as the scaled system. Scaling from a few videos to 50–100 channels should be achieved primarily by adding workers and infrastructure capacity, not by rewriting business logic.

Primary quality attributes, in priority order:

1. reliability and recoverability of long-running jobs;
2. ease of changing video-processing and publishing integrations;
3. traceability of every produced artifact and publication;
4. simple MVP development and local operation;
5. horizontal scaling of resource-intensive workers;
6. reasonable token and maintenance cost for the AI engineering team.

## 2. Architecture at a glance

The backend starts as a **modular backend deployment with independently deployable workers**. The product itself is a distributed REST API system because frontend, backend and workers are separate applications. It is not a microservice system in the MVP.

- `web`: private SPA administration panel;
- `api`: HTTP API, validation and application use cases;
- `scheduler`: Twitch monitoring and scheduled work creation;
- `media-worker`: download, FFmpeg and media transformations;
- `ai-worker`: metadata, thumbnails and external clipping services;
- `publishing-worker`: platform publication and status reconciliation;
- PostgreSQL: authoritative persistent state;
- Redis and BullMQ: dispatch of background work, retries and rate limits;
- S3-compatible object storage: source, intermediate and final media.

Processes may initially run on one machine. Workers can later be replicated independently. A module may become a microservice only after measurements demonstrate a concrete need.

## 3. Repository and platform baseline

Use a TypeScript monorepository:

```text
content-factory/
├── apps/
│   ├── web/
│   ├── api/
│   ├── scheduler/
│   └── worker/
├── packages/
│   ├── api-client/
│   ├── contracts/
│   ├── database/
│   ├── config/
│   ├── observability/
│   └── test-utils/
├── infrastructure/
└── docs/
    ├── decisions/
    └── product/
```

Baseline tooling:

- package manager: `pnpm` workspaces;
- task runner: Turborepo;
- runtime: current supported Node.js LTS;
- local infrastructure: Docker Compose;
- CI: lint, typecheck, unit, integration, contract and selected E2E tests.

Nx is not required initially. Reconsider it only if project-graph enforcement, affected builds or repository size create a measured problem.

## 4. Frontend architecture

### 4.1 Technology

- Nuxt 4 in client-side SPA mode;
- Vue 3 and TypeScript in strict mode;
- Tailwind CSS 4;
- PrimeVue 4;
- Pinia;
- TanStack Vue Query with the Nuxt integration;
- Zod for runtime validation at frontend trust boundaries;
- generated OpenAPI client;
- Vitest, Vue Test Utils and Playwright.

SSR, SSG, SEO rendering and a Nitro BFF are outside the baseline. Nuxt is used for routing, layouts, conventions, modules and development ergonomics.

The absence of JWT does not mean the deployed panel may be publicly reachable without protection. For a private deployment, access should be restricted at the infrastructure boundary, for example by a private network, VPN or access proxy. Application authentication can be added later through an ADR if the operating model changes.

### 4.2 Structural pattern

Use **Nuxt-adapted Feature-Sliced Design**, preserving Nuxt's native `app/pages`, `app/layouts`, middleware and plugin conventions.

```text
apps/web/app/
├── pages/       # route composition only
├── layouts/
├── widgets/     # substantial page sections
├── features/    # user actions and workflows
├── entities/    # domain-facing UI models
└── shared/      # UI kit, API primitives, generic utilities and config
```

Allowed dependency direction:

```text
pages -> widgets -> features -> entities -> shared
```

A lower layer must never import an upper layer. Cross-feature imports are prohibited; shared logic must be moved to the appropriate entity or shared module. Pages coordinate features but do not contain business rules or raw HTTP calls.

### 4.3 Type safety and runtime validation

Strict typing is required even for this private administration panel. TypeScript checks compile-time relationships, while Zod validates values that enter the application at runtime.

- the generated OpenAPI client is the compile-time source of truth for API request and response DTOs;
- do not manually duplicate generated API types or scatter raw HTTP calls through components;
- use Zod for forms, route and query parameters, browser storage, runtime configuration and external or otherwise untyped data;
- infer validated form and UI model types from their Zod schemas where practical;
- do not use `any` to bypass validation or typing;
- if a third-party library exposes untyped data, contain it in a small adapter and narrow it to an owned type immediately.

Zod schemas belong to the lowest FSD layer that owns the validated concept. Generic validation primitives live in `shared`, entity rules in `entities`, and workflow-specific form schemas in `features`. Components consume parsed values and must not silently cast unknown input.

### 4.4 State ownership

- Vue Query owns remote server state, caching, invalidation, loading and request errors.
- Pinia owns durable client-only state shared across routes, such as editor drafts or UI preferences.
- URL query parameters own filters, sorting, pagination and shareable view state.
- Component state owns short-lived form and dialog state.

Do not copy Vue Query results into Pinia. Do not build one global application store.

### 4.5 UI system

- PrimeVue supplies accessible complex controls.
- Tailwind supplies layout and targeted styling.
- Project-level wrappers and design tokens live in `shared/ui`.
- Business components must use semantic tokens instead of arbitrary product colors.
- PrimeFlex is not part of the baseline.

## 5. Backend architecture

### 5.1 Technology

- NestJS and TypeScript;
- PostgreSQL;
- Prisma ORM and migrations;
- Redis and BullMQ;
- FFmpeg/FFprobe invoked by isolated workers;
- S3-compatible object storage, MinIO locally;
- OpenAPI as the frontend contract;
- Pino structured logging;
- OpenTelemetry-compatible tracing and metrics;
- unit, integration and API contract tests.

Python is not required for the initial business backend. Introduce a Python service only when an owned ML/media capability has a concrete dependency on the Python ecosystem. It communicates through a versioned job contract and never accesses another module's database tables directly.

### 5.2 Structural pattern

Use **modular DDD with Clean Architecture boundaries**, applied pragmatically.

Initial bounded modules:

- Sources;
- Channels;
- Projects;
- Media Pipeline;
- Templates;
- AI Content;
- Publications;
- Scheduling;
- Analytics;
- AI Office.

Complex modules use:

```text
module/
├── domain/          # entities, value objects, rules, domain events
├── application/     # commands, queries, use cases and ports
├── infrastructure/  # Prisma, queues and external adapters
└── presentation/    # HTTP controllers and DTOs
```

Simple CRUD modules may use a reduced structure. Creating empty layers and abstractions without a current use case is prohibited.

Domain and application code must not import Prisma, BullMQ, FFmpeg or vendor SDKs. Integrations implement ports such as `VideoSourceProvider`, `ClipGenerationProvider`, `ObjectStorage`, `MediaProcessor` and `PublishingProvider`.

### 5.3 Data and module ownership

- PostgreSQL is the source of truth for projects, pipeline states and publications.
- Redis is disposable coordination infrastructure, not the sole record of business state.
- Each module owns its data and exposes behavior through application services or events.
- Direct cross-module repository access is prohibited.
- Database transactions protect local consistency; asynchronous events coordinate long operations.

CQRS is used lightly: separate command and query handlers where this clarifies workflows. Event sourcing is not part of the baseline.

## 6. Job architecture

HTTP requests never perform downloading, encoding or publication. They validate input, persist intent and enqueue work.

Canonical project states:

```text
DRAFT
SOURCE_PENDING
SOURCE_READY
PROCESSING
CONTENT_GENERATION
REVIEW_REQUIRED
READY_TO_PUBLISH
SCHEDULED
PUBLISHING
PUBLISHED
FAILED_RETRYABLE
FAILED_FINAL
CANCELLED
PAUSED
```

Every job type defines:

- versioned input and output schema;
- idempotency key;
- timeout and concurrency;
- retry count and exponential backoff;
- recoverable and unrecoverable errors;
- per-provider or per-channel rate limit;
- progress events and structured logs;
- cleanup and compensation behavior.

Workers must be safe to restart. A reconciliation process restores missing queue work from authoritative database state. Publication jobs must prevent duplicate uploads.

## 7. Media and integrations

Twitch URLs and uploaded files differ only in ingestion. Both produce a canonical `VideoSource` and stored source artifact, after which they enter the same pipeline.

External providers are adapters behind owned interfaces. Provider payloads do not leak into domain entities. Original, intermediate and final media are stored in object storage with retention rules; PostgreSQL stores metadata, checksums and object keys, never large video blobs.

Generated artifacts retain lineage:

- source and source version;
- processing recipe and template versions;
- FFmpeg command/configuration version;
- AI provider/model and prompt version;
- timestamps and checksums;
- destination channel and external publication identifier.

## 8. Delivery and engineering management

Use vertical slices: each delivery should complete a user-observable scenario across UI, API, persistence and workers. Avoid building all layers horizontally before an end-to-end path exists.

Git and quality rules:

- trunk-based development with short-lived branches;
- one bounded task per pull request;
- Conventional Commits;
- protected main branch;
- required lint, typecheck and relevant tests;
- independent reviewer; an implementation agent cannot be the sole approver;
- architecture boundaries checked by lint rules and tests where practical.

Definition of Done includes acceptance criteria, tests, observability, failure behavior, migrations, documentation and rollback considerations.

## 9. Architecture change policy

This document is a baseline, not an immutable technology mandate. Architecture and technology may change, but no agent or engineer may change them silently.

Before installing or upgrading a dependency, the responsible engineer must check the official documentation, current stable release, compatibility matrix and changelog. Installation commands must come from current official documentation, versions must be pinned reproducibly and a smoke test must be recorded. For example, as verified on 2026-08-31, the Nuxt module listing documents `@peterbud/nuxt-query` and the command `npx nuxi module add @peterbud/nuxt-query`; this snapshot must be rechecked when implementation begins.

A significant change requires an Architecture Decision Record in `docs/decisions/ADR-NNN-title.md` containing:

1. problem and evidence;
2. current constraints;
3. at least two viable options, including retaining the current approach;
4. effects on product delivery, operations, security, data and AI-agent cost;
5. migration and rollback plan;
6. measurable success criteria;
7. tech-lead recommendation and approval status.

Tech-lead review is mandatory for changes to framework, database, queue, module boundaries, deployment topology, API compatibility, persistence model or architectural style.

The tech lead should approve a change only when its measured benefit exceeds migration and long-term maintenance cost. Popularity, novelty or agent preference are not sufficient reasons.

Emergency changes may be applied to restore service, but the ADR and review must be completed immediately afterward.

## 10. Explicitly deferred choices

- microservices;
- Kubernetes;
- event sourcing;
- a service mesh;
- multi-tenancy, billing and public registration;
- SSR/SSG and a frontend BFF;
- application JWT authentication while access is enforced privately;
- owned Python ML services;
- Temporal as workflow engine;
- GraphQL.

Each deferred choice may be revisited through the architecture change policy when a concrete requirement appears.
