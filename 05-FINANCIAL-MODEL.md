# Content Factory — Funnel and Financial Model

Status: planning model, not a revenue forecast. Currency values are RUB/month unless stated. Replace assumptions with cohort data after every 30-day cycle.

## Critical distinctions

- Sponsor revenue is usually priced from recent average views, niche, geography, retention and deliverable, not subscriber count alone.
- A public 2026 market benchmark places gaming integrations around USD 15–30 CPM, but a new Russian-language clip network may realize much less. The model therefore uses conservative RUB ranges and a fill-rate haircut.
- Twitch currently requires 25 followers, 4 streamed hours, 4 different days and 3 average viewers for Affiliate eligibility. 1,000 followers remains our commercial traction goal, not the technical advertising threshold.
- Movie/anime channels without explicit rights are excluded from base revenue. Copyright claims, reused-content decisions and termination can reduce expected revenue to zero.

## Portfolio funnel

```text
published videos
-> impressions
-> views
-> sponsor-eligible views
-> filled sponsor slots
-> sponsor revenue
-> disclosed CTA to owner's Twitch
-> visits
-> follows
-> recurring live viewers
```

Self-promotion must be disclosed and must not falsely claim an independent advertiser relationship. We can package the placement like a normal sponsor creative, but cannot mislead viewers about ownership or impersonate a third-party purchase.

## Two scenarios for the 10-channel pre-production portfolio

Assumptions: 8 horizontal videos per channel/month, 80 videos total. Revenue is shown only after a stable cohort exists.

| Variable                  | Conservative | Working/base |
| ------------------------- | -----------: | -----------: |
| Average views/video       |        3,000 |       10,000 |
| Monthly horizontal views  |      240,000 |      800,000 |
| Sponsor fill rate         |          15% |          40% |
| Realized sponsor CPM      |      400 RUB |      900 RUB |
| Monthly sponsor revenue   |       14,400 |      288,000 |
| Operating cost assumption |       90,000 |      140,000 |
| Monthly contribution      |      -75,600 |      148,000 |

Formula: `videos × average views × fill rate × realized CPM / 1,000`.

This table deliberately does not count YouTube programmatic revenue, vertical-video revenue or unlicensed content. They are upside only after verified eligibility and payouts.

## Planning cost ranges

| Stage              |                       One-time build/test | Monthly operations | What dominates                                              |
| ------------------ | ----------------------------------------: | -----------------: | ----------------------------------------------------------- |
| MVP, 1–2 channels  | 150k–450k equivalent effort over 3 months |            20k–60k | AI dev tools, VDS/GPU time, storage, clipping subscriptions |
| Pre-production, 10 |                      +100k–300k hardening |           70k–180k | processing, storage/egress, AI/API plans, review labor      |
| Production, 50     |                    +300k–900k scaling/ops |          250k–650k | worker fleet, object storage, monitoring, operators         |
| Production, 100    |                    +500k–1.5m scaling/ops |          450k–1.2m | compute, provider enterprise plans, people and sales        |

The owner's stated AI-development budget ceiling of 50k/month fits the MVP experiment, but infrastructure and content operations must be tracked separately.

## Break-even

Break-even monthly views:

`operating cost × 1,000 / (fill rate × realized sponsor CPM)`

Examples:

- conservative economics: `90,000 × 1,000 / (0.15 × 400) = 1.5m views/month`;
- base economics: `140,000 × 1,000 / (0.40 × 900) ≈ 389k views/month`.

At 80 horizontal videos/month, this is about 18,750 average views/video in the conservative case or 4,861 in the base case.

## Payback illustration

If cumulative pre-revenue investment is 450k and stable monthly contribution is 148k, simple payback is about 3.0 months after reaching that stable state. If the conservative case persists, there is no payback; the experiment must change or stop. Time spent ramping before stable revenue is added to the calendar payback period.

## Time-to-traction hypotheses

There is no defensible universal average for a new channel. Use gates:

- months 1–3: validate production and identify at least one content/packaging cohort with repeatable distribution;
- months 4–6: expand toward 10 channels only if unit cost, copyright status and median views improve;
- months 6–12: plausible window to reach sponsor-worthy portfolio reach, but not a promise;
- stop or pivot any cohort after 30–50 consistently published videos if impressions, retention and returning viewers show no improving trend.

## Twitch conversion experiment

Do not forecast a single conversion rate before measuring it. Plan three cases from unique exposed viewers to follows:

| Case    | Follow conversion | Views needed for 1,000 follows |
| ------- | ----------------: | -----------------------------: |
| Low     |             0.10% |                      1,000,000 |
| Working |             0.35% |                       ~286,000 |
| Strong  |             1.00% |                        100,000 |

Deduplicate viewers where possible and distinguish click, channel visit, follow and recurring live viewer. Run channel-specific links/codes and compare sponsor-style placements against end-card and description CTAs.

## Decision gates

- Do not scale from 2 to 10 channels until cost per approved asset and human minutes per asset are known.
- Do not scale from 10 to 50 until at least two cohorts have repeatable distribution and clean rights/platform history.
- Do not purchase annual enterprise clipping capacity until benchmark quality and API suitability are proven.
- Treat sponsor fill rate as zero until there is a real offer or signed campaign.
