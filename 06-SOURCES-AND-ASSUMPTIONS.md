# Sources, Verification Dates and Assumptions

Verified 2026-09-01.

## Official/current technical sources

- Nuxt module listing for `@peterbud/nuxt-query`: https://nuxt.com/modules/nuxt-query
- PrimeVue Nuxt integration: https://primevue.org/nuxt/
- PrimeVue Tailwind integration: https://primevue.org/tailwind/
- OpusClip plans and credits: https://help.opus.pro/docs/article/plans-and-credits
- OpusClip pricing: https://www.opus.pro/pricing
- Vizard pricing: https://vizard.ai/pricing
- Vizard API pricing/limits: https://docs.vizard.ai/docs/pricing
- Eklipse product: https://eklipse.gg/
- Eklipse Premium price: https://eklipse.gg/help/how-much-does-eklipse-premium-cost/
- Eklipse daily limits: https://eklipse.gg/help/how-many-clips-can-i-make-every-day/
- Twitch Affiliate requirements: https://help.twitch.tv/s/article/joining-the-affiliate-program
- Twitch Affiliate advertising settings: https://help.twitch.tv/s/article/affiliate-settings-guide
- YouTube creator/monetization resources: https://www.youtube.com/creators/resources/
- PostgreSQL Docker Official Image (`postgres:18.6`): https://hub.docker.com/_/postgres
- Redis Docker Official Image (`redis:8.10.1`): https://hub.docker.com/_/redis
- MinIO Community security release (`RELEASE.2025-10-15T17-29-55Z`): https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
- MinIO Community source-only distribution notice: https://github.com/minio/minio
- Prisma ORM 7 PostgreSQL driver-adapter setup (`prisma.config.ts`,
  `prisma-client`, `@prisma/adapter-pg`):
  https://www.prisma.io/docs/orm/overview/databases/postgresql
- Prisma 7 database driver requirements:
  https://docs.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers
- Prisma packages (`@prisma/client`, `@prisma/adapter-pg`, and CLI), pinned to
  `7.10.0`: https://www.npmjs.com/package/@prisma/client
- NestJS OpenAPI and multipart documentation, `@nestjs/swagger` pinned to
  `12.0.1`: https://docs.nestjs.com/openapi/introduction and
  https://docs.nestjs.com/openapi/operations
- AWS SDK for JavaScript v3 S3 upload examples, `@aws-sdk/client-s3` and
  `@aws-sdk/lib-storage` pinned to `3.1123.0`:
  https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html
- AWS S3 action-to-permission mapping used for the source-prefix least-privilege
  policy (`PutObject`, `DeleteObject`, multipart abort/list):
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html
- AWS S3 policy resource scoping for a single bucket/prefix:
  https://docs.aws.amazon.com/us_en/AmazonS3/latest/userguide/access-policy-language-overview.html
- Multer security advisory; versions before `2.3.0` are affected by an
  asynchronous file-filter limit bypass: https://github.com/expressjs/multer/security/advisories/GHSA-qvfw-j98x-7q72
- Tiny playable H.264/MP4 fixture embedded as base64 in tests, source and
  browser data-URI example: https://gist.github.com/dmlap/5643609. Retrieved
  2026-09-01; committed fixture SHA-256 is
  `a901150457a87eb8ff4f7c43137f8c6c8c8ab1396274dc76db49b98fc12f3692`.

## Stage 1 upload dependency decision

The source-upload slice uses Prisma `7.10.0`, not the Prisma 8 release candidate
reported by the package registry on 2026-09-01. Version 7.10.0 is the current
fully supported compatibility choice for the approved architecture and the
official PostgreSQL driver-adapter setup. All new direct dependencies are exact
pins in `apps/api/package.json`; the pnpm lockfile captures transitives.

Additional exact pins verified from their official package registry entries on
2026-09-01: `pg@8.23.0`, `multer@2.3.0`, `class-validator@0.15.1`,
`class-transformer@0.5.1`, `dotenv@17.4.2`, `supertest@7.2.2`,
`@types/multer@2.2.0`, `@types/pg@8.23.1`, and
`@types/supertest@7.2.1`.

## Market benchmarks, not guarantees

- 2026 sponsorship ranges by niche: https://outlierkit.com/resources/youtube-sponsorship-rates/
- Cross-check sponsorship CPM framing: https://1of10.com/blog/youtube-sponsorship-rates/

## Explicit assumptions needing validation

- videos per channel per month;
- average views at 30 and 90 days;
- sponsor CPM and inventory fill rate;
- conversion from exposed viewer to Twitch follow;
- human review minutes per output;
- provider price at production volume;
- render and storage cost per source hour;
- legal authorization for every source category.

## Local infrastructure risk to revisit before pre-production

MinIO Community became source-only and its upstream repository was archived in 2026. The local MVP Compose configuration therefore builds the last security
release from its pinned upstream tag instead of trusting an unmaintained
third-party image. This remains suitable only for the local MVP. Before
pre-production, re-evaluate supported S3-compatible storage, its licensing,
security-update path, migration path and backup/restore procedure in an ADR.

All financial values in `05-FINANCIAL-MODEL.md` are scenario assumptions. They are not sourced claims about guaranteed performance.
