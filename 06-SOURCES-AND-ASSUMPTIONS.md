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
