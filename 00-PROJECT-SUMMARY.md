# Content Factory — Project Summary

## Goal

Build a private REST API based content factory that turns long source videos into horizontal and vertical videos, packages them, publishes them to managed channels, and measures results.

The product is not a Laravel/Vue-style monolith. The Nuxt frontend and backend are independent applications connected only through a versioned REST API. Media processing and publication run in independent workers.

## Scale, not feature scope

- MVP: the complete product flow for 1–2 channels and low concurrency.
- Pre-production: the same product for 10 channels in several niches.
- Production: the same product for 50–100 channels.

MVP does not mean a disposable reduced architecture. The difference is capacity, operational automation and concurrency. Every rollout phase may still use feature flags and manual gates while a capability is being validated.

## Baseline

- Frontend: Nuxt 4 SPA, Vue, TypeScript, Tailwind, PrimeVue, Pinia, TanStack Vue Query.
- Backend: independent NestJS REST API, PostgreSQL and Prisma.
- Async work: Redis, BullMQ and independently scalable workers.
- Media: FFmpeg/FFprobe, object storage and external AI clipping adapters.
- Contracts: OpenAPI-generated TypeScript client.
- Repository: pnpm workspace and Turborepo.
- Architecture changes: ADR plus independent tech-lead approval.

## Current business hypothesis

Start with 1–2 licensed or otherwise authorized sources, prove quality and throughput, then test a 10-channel portfolio. Direct sponsorship/banner integrations in horizontal videos are the primary revenue hypothesis. Vertical videos are primarily discovery inventory until actual conversion data proves otherwise.

Movie and anime clips are not part of the base financial forecast unless rights are obtained. They carry materially higher copyright and reused-content risk.

## Decisions still requiring experiments

- views per video and time to stable distribution;
- sponsor fill rate and attainable sponsor CPM;
- conversion from external views to the owner's Twitch channel;
- clip-provider quality by source type;
- human review time per output;
- storage, rendering and API cost per source hour;
- which operations can safely move from review-required to automatic.
