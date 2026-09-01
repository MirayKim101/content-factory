# MVP, Pre-production and Production

## One product, three capacities

| Stage          | Channels | Purpose                                 | Operating mode                                 |
| -------------- | -------: | --------------------------------------- | ---------------------------------------------- |
| MVP            |      1–2 | prove the full pipeline and unit cost   | manual approval, low concurrency               |
| Pre-production |       10 | prove portfolio economics across niches | canary rollout, scheduled batches              |
| Production     |   50–100 | scale validated recipes                 | multiple worker pools and automated safeguards |

All stages support the same complete journey: ingest, analyze, choose segments, horizontal render, vertical render, packaging, quality gate, scheduling, publishing and analytics. A capability may temporarily remain behind a manual approval gate while its reliability is measured.

## Human operating-time targets

These are planning targets, not measured facts:

| Stage        | Mature weekly owner/operator time | Main work                                                                            |
| ------------ | --------------------------------: | ------------------------------------------------------------------------------------ |
| MVP          |                             3–8 h | review every output, classify failures, tune recipes                                 |
| 10 channels  |                           10–25 h | exceptions, scheduling, sponsor inventory, analytics                                 |
| 50 channels  |                           30–70 h | portfolio decisions, QA sampling, incidents, sales                                   |
| 100 channels |                          60–120 h | requires at least one operations/content role unless exception rate is extremely low |

The software can automate rendering and publishing; it cannot honestly make copyright review, sponsor sales, editorial judgment and platform incidents disappear. Measure minutes of human attention per published asset from the first MVP run.

## Capacity metrics

- source hours ingested per day;
- output minutes rendered per source hour;
- queue wait and processing time by job type;
- cost per source hour and per published asset;
- failure and manual-intervention rates;
- duplicate-prevention events;
- approved outputs per operator hour;
- storage growth and retention cost;
- per-channel publication limits and platform warnings.

## Long-VOD planning scenario

For capacity experiments, not forecasts, use:

```text
source GiB ≈ bitrate Mbps × duration hours × 0.43945
```

A five-hour VOD at 4–8 Mbps is roughly 9–18 GiB. Ten such daily sources imply
about 90–180 GiB/day and 1.2–2.5 TiB for 14 days of raw retention before
intermediates and finals. Measure actual bitrate, arrival bursts and retention
before selecting VDS or worker counts.

Capacity is bounded per stage. The system accepts a batch immediately, runs only
the jobs admitted by network, CPU/GPU, disk and provider budgets, and keeps the
rest visibly queued with fairness between channels. An initial planning window
of under 12 hours is an experiment, not an approved SLA.

Before moving from 2 to 10 channels, measure source-hours per worker-hour,
queue/processing p50 and p95, peak scratch, GiB-days, cost per source hour and
operator minutes per approved asset. The 10-to-50 gate additionally requires
validated demand, rights, provider economics and a benchmark proving the
editorial window. See ADR-002.
