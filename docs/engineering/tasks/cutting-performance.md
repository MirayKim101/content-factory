# Cutting performance — MVP capacity gate

Статус: P0 cache, telemetry, bounds confirmation and recipe v2 complete

Дата: 2026-09-02

## Целевая нагрузка MVP

- 5–10 исходных видео;
- 3–5 независимых отрезков на исходник;
- 15–50 `CUT_SEGMENT` jobs за рабочую сессию;
- один отрезок по-прежнему создаёт один независимый MP4.

## Фактическое наблюдение

Последний репрезентативный пользовательский job `0fa88d85…` имел сохранённые
границы `195000–1728000 ms` (`03:15–28:48`), а не ожидаемые
`12:46–13:21`. Фактическая длительность составила `25:33`.

- ожидание очереди: `0.025 s`;
- worker wall time: `2251.648 s` (`37:31`);
- скорость обработки: примерно `0.68× realtime`;
- размер результата: `540871550` bytes.

Этот исторический job нельзя использовать как оценку времени 35-секундной
нарезки; отдельный точный benchmark приведён ниже.

## Реальный 35-секундный benchmark

Все календарные часы ниже указаны в `Asia/Novosibirsk (UTC+7)`. PostgreSQL
хранит timestamps в UTC; длительности считаются как разность authoritative
timestamps и не зависят от часового пояса.

После внедрения cache и recipe `stage1-cut-h264-v2` выполнены два реальных job
на существующем source размером `3813099228` bytes:

- `12:46–13:21`, cold cache: total `25031 ms`, encode `14924 ms`, download
  `4621 ms`, integrity hash `5204 ms`, output `8261830` bytes;
- `13:21–13:56`, cache hit: total `15406 ms`, encode `15246 ms`, повторные
  download/hash отсутствуют, source probe cache hit `0.02 ms`, output
  `9846503` bytes.

Оба результата имеют `READY`, duration `35000 ms`, attempt `1`, независимые
object keys и SHA-256. Cold job прошёл примерно в `2.5×` быстрее старого
`medium` pipeline (`62847 ms`), cache-hit job — примерно в `3.1×` быстрее
старого cache-hit результата (`47320 ms`).

Изолированный preset benchmark того же диапазона:

| Preset     | Encode time | Output size | SSIM     |
| ---------- | ----------- | ----------- | -------- |
| `medium`   | `52027 ms`  | `10362383`  | baseline |
| `faster`   | `27877 ms`  | `9598776`   | `0.9724` |
| `veryfast` | `15191 ms`  | `8261830`   | `0.9712` |

На дату этого baseline новые jobs использовали `stage1-cut-h264-v2`
(`veryfast`, CRF 20, AAC 192k); текущая v3 описана ниже.
Старые jobs с `stage1-cut-h264-v1` воспроизводимо остаются на `medium`.

## Найденные причины

1. Каждый job скачивает весь исходник из MinIO в отдельный scratch, даже если
   несколько jobs относятся к одному source.
2. Каждый job повторно выполняет source probe.
3. Видео полностью перекодируется через `libx264 -preset medium`, аудио — AAC.
4. Worker имеет concurrency `1`, контейнер ограничен двумя CPU.
5. Интерфейс получает FFmpeg progress только после полного скачивания и probe;
   фазы до encode выглядят как долгое ожидание без прогресса.
6. Нет отдельных метрик download/probe/encode/output-probe/hash/upload.

## Решение команды

### P0 — достоверность и baseline

- показывать перед submit нормализованные start/end и длительность каждого
  отрезка;
- добавить phase telemetry: queue wait, source download, source probe, encode,
  output probe, hash, upload и total;
- выполнить контролируемый тест ровно `12:46–13:21` на существующем исходнике
  без повторной загрузки файла.

### P0 — bounded worker-local source cache

Кэшировать исходник по immutable identity `(sourceId, sourceVersion, sha256)`.

- single-flight fill и atomic temp-to-ready;
- проверка size/checksum;
- permissions `0700/0600`;
- refcount, LRU/TTL и отдельный byte budget;
- запрет eviction используемого entry;
- cache miss после restart/corruption безопасно повторяет download;
- PostgreSQL, attempts, leases и artifacts остаются authoritative;
- output остаётся отдельным и attempt-specific для каждого job.

Цель: один физический source download на worker/cache lifetime; уменьшение
скачанных source bytes минимум на 60% для трёх и на 80% для пяти отрезков.

### P1 — encoder benchmark

После кэша сравнить `medium`, `faster`, `veryfast` на одинаковых входах. Для
каждого варианта измерить wall time, encode speed/fps, CPU, output size и
визуальное качество. Изменение preset требует новой `recipeVersion`, canary и
rollback, но не нового ADR.

### P1 — ограниченная параллельность

Сравнить concurrency `1` и `2` только после baseline/cache. При двух CPU и
scratch budget `24 GiB` повышение concurrency может ухудшить throughput. Три
одновременных больших исходника в текущий scratch budget не помещаются.

### Deferred

- source-scoped batch требует отдельного ADR, если local cache не даст нужного
  hit rate;
- shared persistent cache пока отклонён из-за cross-worker locks, poisoning,
  eviction и нового failure domain;
- `-c copy` не используется по умолчанию: произвольные таймкоды могут стать
  неточными из-за keyframes;
- hardware encoding рассматривается после portable CPU benchmark.

## Capacity acceptance

1. Baseline: 5 источников × 3 clips; stress: 10 × 5.
2. Для каждого job записаны queue/run/wall и длительности всех фаз.
3. Все результаты проходят ffprobe; длительность соответствует диапазону с
   допуском до кадра или 200 ms.
4. Artifact checksum, object key и download каждого результата независимы.
5. Повтор idempotency key не создаёт duplicate artifact.
6. Restart активного worker восстанавливает jobs без дублей.
7. Controlled failure корректно retry/finalize.
8. Отчёт содержит p50/p95, clips/hour, CPU/RAM/scratch/network и source cache
   hit/miss/eviction/download bytes.

## Capacity baseline 5 × 3 — итог

Тест выполнен 2026-09-02 на одном локальном media-worker с concurrency `1`:
пять `CutRequest` по три независимых 30-минутных результата. Все времена БД
ниже переведены из UTC; wall time не зависит от часового пояса.

- 15 из 15 jobs завершились `READY`; retries, failures и pending cleanup: `0`;
- общий wall time: `3:35:06.329` (`12906329 ms`), throughput: `4.184 clips/hour`;
- run time: p50 `871542 ms`, p95 `1036553 ms`;
- queue wait: p50 `5693847 ms`, p95 `11517399 ms`;
- encode: p50 `868780.37 ms`, p95 `1032843.50 ms`;
- source/probe cache: один miss и 14 hits, evictions `0`;
- исходник размером `3813099228` bytes скачан один раз за `5109.78 ms`;
- созданы 15 уникальных artifact IDs и object keys общим размером
  `10412342617` bytes (примерно `9.697 GiB`);
- одинаковые диапазоны закономерно дали одинаковые checksums: уникальных
  checksums `9`, но физических result objects и lineage records по-прежнему 15;
- независимый FFprobe всех объектов подтвердил ровно `1800000 ms`, H.264 + AAC
  и совпадение размеров с PostgreSQL;
- PostgreSQL, Redis, MinIO и media-worker остались healthy.

HTTP reload/download smoke в момент сбора метрик не выполнялся, потому что API
и web не были запущены. Доступность и целостность всех объектов подтверждены
FFprobe; пользовательский reload/download уже покрыт предыдущим Stage 1 smoke.

Baseline доказывает надёжность и пользу кэша, но concurrency `1` недостаточна
для целевой очереди. Следующий capacity experiment выполняется отдельно:
сначала concurrency `2`, затем `4` только при безопасных CPU/RAM/scratch
показателях и без изменения бизнес-логики jobs.

## Recipe v3 — ограничение потоков FFmpeg

Проверка 2026-10-03 выполнена как изолированный диагностический cut, а не как
новый capacity baseline. Она сравнивает прежний runtime image
`content-factory-worker:diagnostic-prod-20261003-8ae525e37920` с recipe v2 и
candidate image `content-factory-worker:diagnostic-prod-20261003-88913598440e`
с recipe v3. Candidate собран из immutable commit
`88913598440e87c80df8d0263dc3f3e13d8a13ce`.

Отдельный no-cache candidate `3738e1f83f154619387cab3e5da3ed9e3812e1df`
имел идентичные `apps/worker/Dockerfile` и `apps/worker/src` с измеренным
candidate; его image
`content-factory-worker:diagnostic-prod-20261003-3738e1f83f15` отдельно
создал тот же H.264-only output (SHA-256
`dd3b1c6612fbbf8319b311bcb884f9646df80360a8d91d9284043d61d5503321`,
1920×1080, 24 fps, 12,000 ms).

- source: `tmp/worker-media-fixture-fZCgHN/source-faststart.mp4`;
  SHA-256 `2dfb40e475787162be3ac3b00a104308e85d00655f3ffe6814c5f82f293a5978`;
  18,386 bytes; H.264 1920×1080, 24 fps, 12,000 ms, без audio stream;
- оба запуска: `--network none`, read-only root filesystem, `--cpus 1`,
  `--memory 512m`, `--pids-limit 128`, `FFMPEG_THREADS=1`, один полный
  отрезок 0–12,000 ms;
- sampler работает внутри того же PID cgroup и каждые 25 ms читает
  `pids.current` и `/proc/<ffmpeg-pid>/task`; он не создаёт дочерние процессы.

| Recipe/image        | Max cgroup PIDs | Max FFmpeg tasks | Reserve below 128 | Output SHA-256                                                     | ffprobe                    |
| ------------------- | --------------: | ---------------: | ----------------: | ------------------------------------------------------------------ | -------------------------- |
| v2 / `8ae525e37920` |              75 |               66 |                53 | `7647174ecf0062dc5f04860c68b318edbb554abbb4e0b54024078ac85855fdd5` | H.264 1920×1080, 12,000 ms |
| v3 / `88913598440e` |              10 |                1 |               118 | `dd3b1c6612fbbf8319b311bcb884f9646df80360a8d91d9284043d61d5503321` | H.264 1920×1080, 12,000 ms |

Retained raw metrics: `tmp/worker-v3-benchmark-AnTiHJ/before.metrics` and
`after.metrics`, with 1,597 / 193 sampler observations respectively. These are
counts, not elapsed milliseconds. Earlier unretained figures (77/12 PIDs,
1,389/152 observations) are not used as reproducible acceptance evidence.

`v3` keeps v2's H.264 `veryfast`/CRF 20, pixel format, optional audio mapping,
AAC parameters and `+faststart`; it adds only `-filter_threads 1`, decoder
`-threads:v 1` before `-i`, and encoder `-threads:v 1` after the input. The
fixture contains no audio stream, so the expected and observed outputs are
video-only; this check does not claim an AAC result. The results demonstrate
thread containment for this fixture under the stated limits, not a general
throughput or visual-quality capacity claim.

## Combined v3 API/worker acceptance

The same disposable source was admitted through the actual API candidate
`3320af272a63ea89be9a0b4e5bcbd133d9d5ac47` and processed by worker candidate
`e5115c875b22aa23b2e0aa532e5ed48c6548f966`. Both ran non-root/read-only under
the one-CPU/PID-128 diagnostic profile with manual rights and external flags off.

- One-second cut: READY, attempt 1, 3,889 bytes, SHA-256
  `96d208d25724a25649cddea88236b1e42037cbef25fddd80725a6db5149a6b70`.
- Ten-second cut after deletion of only the owned disposable Redis queue:
  PostgreSQL reconciliation produced READY, attempt 1, 21,547 bytes, SHA-256
  `b1cfaf517c78c179135d7510f508ef35d7388ecffb45fb7ac25f68b3586c3753`.
- A separate cut was observed PROCESSING before SIGKILL of only the fixture
  worker. Restart completed attempt 2 with one artifact and that same checksum.
- Replay preserved one logical job/artifact. Both job and artifact persisted
  `stage1-cut-h264-v3`; no legacy recipe was rewritten.
- Destroyed MP4 encoded samples retained a valid upload container, but encoding
  ended in controlled `FFMPEG_CUT_FAILED`, with no ready result.

Private evidence: `tmp/combined-media-evidence-OzWgfW/media-evidence.json`,
SHA-256 `e6e73832cfd47645ee136fbb8ec8b19bcd33797db8e2be52bd38d311763d72d6`.
This is recovery/idempotency acceptance, not production throughput or a general
audio/visual quality benchmark. Rollout worker before API v3 admission; rollback
API admission first and retain v3-capable workers until all v3 intents finish.
