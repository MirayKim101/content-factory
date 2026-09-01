# Content Factory — Architecture and Technology Policy

## System boundary

Content Factory is a distributed application, not a full-stack framework monolith:

```text
Nuxt SPA -> versioned REST API -> PostgreSQL / queues -> independent workers
```

The frontend knows only the OpenAPI contract. The backend never returns framework-rendered pages and does not depend on Nuxt or Vue. This permits a second web client, CLI or mobile app without replacing business logic.

The backend itself begins as a modular deployment for simplicity, but its modules have explicit ownership and ports. Media, AI and publishing workers are separate processes from day one. A module is extracted into a separate service only after an ADR demonstrates an operational need.

## Frontend

- Nuxt 4 in SPA mode (`ssr: false`);
- Vue and strict TypeScript;
- Tailwind CSS and PrimeVue;
- Pinia for global client-only state;
- Vue Query for remote/server state;
- Zod for runtime validation at frontend trust boundaries;
- Nuxt-adapted FSD: `pages -> widgets -> features -> entities -> shared`;
- generated OpenAPI client; raw HTTP calls are not scattered through components.

Nuxt remains valuable for routing, layouts, modules, conventions and developer ergonomics. SSR, SSG, Nitro BFF and application JWT are not baseline requirements. Private access is enforced at the infrastructure boundary until an ADR changes the operating model.

Strict typing is required even though the panel is private. The generated OpenAPI client is the compile-time source of truth for API contracts; frontend code must not duplicate its DTO types by hand. Zod schemas validate untrusted runtime input such as forms, route and query parameters, browser storage, runtime configuration and data that does not pass through a typed owned client. Prefer types inferred from Zod schemas for validated form and UI models. Do not use `any` to bypass a boundary; isolate unavoidable untyped third-party code in a small adapter and narrow it immediately.

## Backend

- independent NestJS REST API;
- modular DDD and pragmatic Clean Architecture;
- PostgreSQL is authoritative state;
- Prisma is persistence infrastructure;
- Redis/BullMQ is disposable job coordination;
- complex modules use domain, application, infrastructure and presentation boundaries;
- external systems are adapters behind owned ports;
- long-running operations never execute inside HTTP requests.

## Scale model

The pipeline and business behavior are identical at 1, 10 and 100 channels. Capacity grows by adding workers, storage, queue partitions and provider quota. Concurrency, rate limits, operational gates, canary rollout and observability become stricter with scale.

## Technology freshness rule

Before installing or upgrading any framework, module, SDK, external API or container image:

1. open the official product documentation and changelog;
2. confirm the current stable version and compatibility matrix;
3. use the official installation command rather than recalled commands;
4. record the version and source URL in the PR or ADR;
5. pin reproducible versions and commit the lockfile;
6. run typecheck, tests and a minimal integration smoke test;
7. require tech-lead review for a baseline change.

As of the 2026-08-31 verification, the Nuxt module listing identifies `@peterbud/nuxt-query` and documents `npx nuxi module add @peterbud/nuxt-query`. PrimeVue's current Nuxt package is `@primevue/nuxt-module`. These are verification snapshots, not permanent commands.

## Change control

Architecture and stack are allowed to evolve. No agent may silently replace a baseline technology. A material change requires an ADR containing evidence, keep-current option, alternatives, migration cost, data impact, operating cost, security impact, rollback plan and tech-lead decision.
