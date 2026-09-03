# Parallel cut benchmark — concurrency capacity gate

Status: in progress (execution evidence is stored locally under `tmp/benchmarks/parallel-cut/`)

## 2026-09-03 execution incident — invalid performance sample

At `21:06:42 UTC+7`, the level-1 request was accepted and created these four
real jobs: `f8292dbe-14ac-4f98-8251-29fcaf612107`,
`19cfc2af-8127-4319-acd2-f7ac212ff123`,
`03584f46-a243-4364-94ec-dad3e9f8d285`, and
`c6052e33-11f1-41e3-b2b4-90f7bab0b6b7`.

The initial runner used `mapfile`, which is unavailable in macOS Bash 3.2, and
its unsafe EXIT handler recreated the media worker even though the newly
accepted batch could have been active. The worker subsequently recovered
healthy at concurrency 1; at first inspection one job was `PROCESSING` and
three were `QUEUED`, all on attempt 1. No second batch was submitted.

This batch is **invalid for performance comparison**: the replacement boundary
can change cache and worker timing, and prior-container structured logs are not
recoverable from the replacement container. At `21:18:56 UTC+7`, the manager
also replaced the API development watcher with the existing compiled API
(`node dist/main.js`) to prevent source-watch restarts; the worker was not
changed. This is an operationally sensible stabilization, but makes the batch
an incident/recovery observation rather than a pure benchmark. Its request,
IDs and preflight evidence remain preserved at:

```text
tmp/benchmarks/parallel-cut/level-1-20260903T210631+0700-b5524440-b600-40da-8eff-6370a21558cd/
```

It remains useful only for correctness/recovery observation. Do not use its
wall time, cache timing or overlap as a benchmark result. No later level may
start until an independent reviewer has approved the corrected runner.

Read-only recovery evidence has one verified `READY` output:
`19cfc2af-8127-4319-acd2-f7ac212ff123` (`20:00–50:00`, attempt 1), finished
at `21:25:16 UTC+7`. Its streamed worker-container FFprobe reports exactly
`1800.000000` seconds, H.264 video and AAC audio. API and PostgreSQL agree on
size `576768310`, SHA-256
`be0e79b15c4cd0ec6c776bc9dadb2dbe8d83efe9d24f3ba8e4618a2fc59216b4`, source
lineage version 1 and recipe `stage1-cut-h264-v2`.

The repeated lease losses remain an incident, not a capacity result. Read-only
macOS power logs show `Idle Sleep` at `21:12:02 UTC+7` and wake at `21:12:49`
(47 seconds); there were no Docker worker-container lifecycle events in the
same window. This overlaps one attempt's last heartbeat and its
`WORKER_LEASE_EXPIRED` finalization, so host/Docker-VM pause is supported as a
contributing explanation. It does not prove the cause of every expiry, notably
the earlier one spanning the unsafe worker replacement.

Independent script review was `CLEAN` after mock-only verification of Bash 3
compatibility, no EXIT recreation, drained-only restore, cold-memory admission,
the pre-POST recheck, queue race, unknown runtime telemetry stop and FFprobe
failure behavior. This approval does not authorize another benchmark before
the incident batch drains and the operational pause condition is addressed.

## Local power safety during real runs

Before any future real benchmark, start exactly one verified read-only monitor
and, only for that monitor's lifetime, create an idle-sleep assertion with:

```sh
caffeinate -i -w <verified-monitor-pid>
```

Record the monitor PID, confirm the matching assertion with `pmset -g
assertions`, and verify the machine's current power source first. This uses
only `-i`: it neither changes persistent `pmset` configuration nor prevents
display sleep or lid-close behavior. It must disappear when that monitor exits
at terminal batch state. Do not create a second monitor or a global power
policy. A future reviewed wrapper may automate this lifecycle; it is not part
of the current benchmark runner.

The owner must connect AC power before the next long baseline or comparison.
Do not submit a new batch while running on battery: the 2026-09-03 preflight
observed 50% battery with approximately 1 hour 20 minutes remaining, which is
not a safe reserve for a multi-clip CPU benchmark. Record `pmset -g batt`
showing AC power in that run's preflight evidence; otherwise treat the manual
capacity gate as closed.

## Purpose

Measure real horizontal 30-minute cutting throughput at worker concurrency 1,
then 2, and only then 4. This is a capacity experiment, not a product or
recipe change. It implements the next experiment named in
`cutting-performance.md` and ADR-002.

## Fixed conditions

- source project: `ef703380-656e-4f15-9c5e-f722c7bbe01b`;
- resolved source version: `146f4b93-5ccd-420f-81fa-1179130da2f8`, version 1,
  `video-test.mp4`, 3,813,099,228 bytes, duration 5,878,827 ms;
- source authorization: `CLEARED`, `OPERATOR_ATTESTATION`;
- recipe: existing `stage1-cut-h264-v2` (veryfast, CRF 20, AAC 192k);
- container CPU cap: exactly 2.0 for every level;
- batch at every level: four independent 1,800,000 ms cuts at `00:00–30:00`,
  `20:00–50:00`, `40:00–70:00`, and `60:00–90:00`;
- the worker starts each level cold, so the cache outcome is comparable: one
  source fill and single-flight waiters rather than a warm cache advantage.

No source media or pre-existing results are deleted. Each new job has new
client IDs, idempotency key, artifact lineage and object key.

## Preflight (2026-09-03, UTC+7)

- all 30 existing jobs are `READY`; no queued, processing or retrying job;
- worker is healthy with concurrency 1, a fixed 2 CPU cap and pids limit 256;
- `/tmp` is a 24 GiB worker-local tmpfs, cache and scratch were empty;
- host disk has 829 GiB free, but that is not the controlling memory limit;
- Docker currently exposes about 7.75 GiB to the worker/VM. Its container
  `memory.max` can be `max` (`HostConfig.Memory=0`), so the runner cannot use
  it as a limit. It samples Docker-VM `/proc/meminfo` (`MemAvailable` and
  `MemTotal`) plus Docker statistics for every service; tmpfs pages are part of
  that VM memory budget. Memory—not disk free space—is the limiting safety
  signal;
- idle worker observed memory was 354 MiB; its local source cache was empty.

The 3.55 GiB source cache plus concurrently growing outputs can make level 4
unsafe despite 24 GiB nominal tmpfs. Level 4 therefore requires evidence from
level 2, not merely a configuration value.

Before a worker recreation or POST, the runner now admits a cold run only when
Docker-VM `MemAvailable` can cover the 3,813,099,228-byte source cache, a
conservative 900 MiB per concurrent output, and a 1 GiB VM reserve. This is
approximately 5.43 GiB at level 1 and 6.31 GiB at level 2. Level 4 requires
about 8.07 GiB and cannot fit into the observed 7.75 GiB VM, so it is expected
to remain a measured capacity gate unless the VM budget changes under a
separate approved operational action.

## Runner and evidence

Run a single authorized level from the repository root:

```sh
scripts/benchmarks/run-parallel-cut-benchmark.sh 1
```

The script validates the project/source, authorization-ready state, empty
queue, actual 2-CPU cap and requested worker concurrency. It recreates only
the media worker (never an active job), submits exactly four cuts, samples
Docker-wide statistics, worker cgroup memory, tmpfs/cache bytes, FFmpeg process
count and process table every 15 seconds, then captures job queue/run times,
structured worker logs and independent FFprobe results for all four objects.
Timestamps use `Asia/Novosibirsk (UTC+7)`.

Evidence resides in a distinct ignored run directory below
`tmp/benchmarks/parallel-cut/`. It contains the submitted request/job IDs,
runtime samples, all-container Docker stats, process snapshots, final API job
states, PostgreSQL-derived queue/run/attempt data, structured logs and one
FFprobe JSON document per output.

The runner validates the pinned worker-container `/usr/bin/ffprobe` before it
changes the worker, then repeats VM admission after the worker is healthy and
immediately before POST. It refuses a level if jobs are active, the source
differs, the worker cannot become healthy, its CPU cap is not exactly 2, or
Docker-VM available memory falls below 1 GiB or 15%. Missing runtime VM
telemetry is also a controlled stop. It does not kill active work on a stop; it
persists evidence and prevents progressing to a higher level.

## Level progression and rollback

1. Run level 1 and record its complete evidence.
2. Check level 1 has four `READY` results, no retry/failure and exact FFprobe
   output.
3. Run level 2 only with the unchanged conditions above. Confirm overlapping
   FFmpeg process intervals from `runtime-samples.tsv` and
   `process-samples.txt`; a concurrency setting alone is insufficient.
4. Run level 4 only if level 2 shows no errors, no unhealthy worker, no memory
   pressure and a conservative projection for four concurrent output scratch
   files above the 1 GiB/15% VM-memory reserve. An independent reviewer must
   inspect that evidence and explicitly permit it with
   `BENCHMARK_LEVEL4_APPROVAL=measured-safe`. Otherwise document the capacity
   gate as a result and keep concurrency 1.

The script never recreates a worker from an EXIT handler. Only after every job
is terminal and the queue is drained does a successful level 2 or 4 explicitly
restore `MEDIA_WORKER_CONCURRENCY=1`; level 1 is already baseline. If a run is
interrupted, wait for its jobs to reach terminal states before any operator
action; never restart a worker with active work. Existing media and persistent
volumes are not removed.

## Required final report

For each executed level report wall time, clips/hour, per-job queue/run time,
phase/cache outcomes, peak CPU/RAM/cgroup/tmpfs/cache, FFmpeg overlap, retries
or errors, artifact integrity, result size/checksum, and FFprobe duration/codecs.
Compare concurrency while keeping the CPU cap and recipe unchanged. State why
level 4 ran or was prevented by a measured safety gate.
