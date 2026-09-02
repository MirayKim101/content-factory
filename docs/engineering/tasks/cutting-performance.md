# Cutting performance — MVP capacity gate

Статус: brainstorm complete, implementation pending

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

Точного замера 35-секундного отрезка пока нет. Нельзя использовать этот job как
оценку времени 35-секундной нарезки.

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
