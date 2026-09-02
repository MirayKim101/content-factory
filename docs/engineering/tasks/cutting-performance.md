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

Новые jobs используют `stage1-cut-h264-v2` (`veryfast`, CRF 20, AAC 192k).
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
