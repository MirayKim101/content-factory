# Content Factory — current handoff

Обновлено: 2026-09-06 (продолжение разработки)
Ветка: `main`
Часовой пояс владельца: `Asia/Novosibirsk (UTC+7)`
Текущий сохранённый commit: `2e31427 feat: add montage asset ingestion and probe`
Сохранённый backend: `406326a`. Frontend manual editorial workspace прошёл
проверку и сохранён локально в `1552490` (без push).

## Решение владельца

- весь MVP до Twitch разрабатывается и тестируется локально;
- VDS пока не покупать; manager сам поднимет вопрос после capacity gate и
  наблюдаемой реальной очереди;
- mobile UI отложен;
- до Twitch нужно завершить Stage 1, Stage 2 и новый Stage 2B AI-assisted;
- metadata и thumbnail независимо поддерживают `MANUAL`, `AI_ASSISTED` и
  `MIXED`; ручной ввод и собственная обложка доступны всегда.

## Готово ранее

- локальные PostgreSQL, Redis, private MinIO и Docker media-worker;
- загрузка MP4 с реальным процентом, media library, `/horizontal` multi-source
  workspace, точные таймкоды, background FFmpeg, status и download;
- до 20 выбранных источников, один активный player, независимые drafts/jobs;
- worker-local verified source cache, phase telemetry и recipe
  `stage1-cut-h264-v2` (`libx264 veryfast`, CRF 20, AAC 192k);
- реальная 29:25 нарезка выполнена за 11:55.696 на cache hit;
- старые jobs v1 остаются на `medium`.

## Завершённый slice: source authorization

Independent review: `CLEAN`.

- ADR-003: version-aware `SourceAuthorization`;
- новые sources: `NOT_REVIEWED`, без фиктивной аттестации;
- 6 legacy sources перенесены как `CLEARED / LEGACY_ATTESTATION` с исходными
  timestamp/declaration version;
- отдельный CAS/idempotent `PUT /api/v1/projects/:id/source-authorization`;
- fail-closed gates для playback, cut transaction, result download,
  dispatch/recovery и worker claim;
- `PipelineJob.sourceVersion` обязателен без default; jobs и artifacts
  проверяются по exact source version и lineage;
- upload checkbox и hardcoded `rightsConfirmed=true` удалены;
- media library показывает статус и отдельный dialog подтверждения;
- unauthorized deep-link не открывает player/editor/submit/download;
- миграции применены локально; media objects не изменялись.

## Завершённый slice: grid редактора и быстрый local smoke

- `/horizontal` показывает независимые карточки с собственными 16:9 players;
- 4 колонки включаются от 1600 px, пятая карточка переносится;
- PrimeVue Dialog каждой карточки содержит компактный editor player, marker
  buttons, несколько timecode pairs и запуск;
- marker берёт время только из player открытого Dialog;
- Dialog ограничен viewport, имеет внутренний scroll, компактный editor player,
  sticky actions и проверенный backdrop/context stack;
- progress, failures, READY и download находятся на source card и остаются
  видимыми после закрытия Dialog;
- `GET /api/v1/projects/:projectId/pipeline-jobs` восстанавливает persisted jobs
  текущей версии source из PostgreSQL после полного reload;
- локальная загрузка server-side получает `LOCAL_DEVELOPMENT_AUTO`, поэтому
  отдельный Dialog подтверждения не мешает тестам;
- manual/production остаётся fail-closed; API возвращает policy-aware
  `authorization.usable`;
- кириллическое multipart filename нормализуется и проверено интеграционно;
- ADR-004 фиксирует конфигурацию, безопасность, миграцию и rollback.

## Проверки текущего slice

- API unit: `42/42`;
- API integration: `34/34`;
- worker unit: `37/37`;
- worker PostgreSQL integration: `5/5`;
- web: `57/57`;
- API/worker/web typecheck и lint: passed;
- OpenAPI generation/drift и `git diff --check`: passed;
- Docker media-worker пересобран, запускается как `node`, healthy,
  `FailingStreak=0`; PostgreSQL, Redis и MinIO healthy.

## AI-решение до Twitch

Architect рекомендует отдельный Stage 2B и отдельный ADR перед реализацией.

- один `CreatorProfile` на стримера: canonical name, official URL, язык,
  тематика, operator/rights notes;
- source context: игра, аудитория, цель, ограничения;
- per-cut prompt: что происходит, акцент, tone, CTA;
- AI использует research snapshot, transcript и sparse frames конкретного cut;
- AI выдаёт drafts, пользователь редактирует и явно подтверждает revision;
- без подтверждённой reference-фотографии likeness не используется;
- Twitch, vertical, publishing и analytics остаются после Stage 2B.

Notion backlog обновлён:
`https://app.notion.com/p/3cff0d44c82d81bd9f5ac01270044f67`.

## Capacity baseline 5 × 3

- 15/15 реальных 30-минутных jobs: `READY`, retries/failures `0`;
- wall time `3:35:06.329`, throughput `4.184 clips/hour` при concurrency `1`;
- run p50 `14:31.542`, p95 `17:16.553`;
- source/probe cache: 1 miss + 14 hits, исходник скачан один раз;
- 15 уникальных result objects, общий объём примерно `9.697 GiB`;
- FFprobe всех результатов: ровно 30 минут, H.264 + AAC;
- подробный evidence: `docs/engineering/tasks/cutting-performance.md`.

## Завершённый backend slice: manual editorial draft

Independent review: `CLEAN`.

- additive migration `20260902210000_stage2_manual_editorial_draft` применена к
  локальной PostgreSQL;
- immutable processing template revisions и editorial package revisions;
- ручные title, description, ordered tags и private thumbnail сохраняются и
  восстанавливаются после reload;
- optimistic revision, idempotency, exact source/result lineage и fail-closed
  project authorization;
- JPEG/PNG/WebP проходят строгую structural validation; corrupt/reserved WebP,
  SVG, fake MIME и pixel bombs отклоняются controlled failure;
- MinIO policy разрешает API только `sources/*` и `editorial/*`; прямой
  anonymous thumbnail URL возвращает `403`, project-scoped API — `200`;
- API integration `38/38`, unit/contract `59/59`; worker `37/37`; web checks,
  lint, typecheck, build, OpenAPI, formatting и diff check passed;
- media-worker не перезапускался, 15 benchmark results и пользовательские
  данные сохранены.

Frontend manual editorial draft принят 2026-09-03: independent review CLEAN.
72/72 штатных и 16/16 независимых regression probes; lint, typecheck, build,
OpenAPI, formatting и diff check passed. Retry identity, late response,
stale-cache hydration и error/retry исправлены и независимо воспроизведены.
Browser smoke подтвердил save/reload разных текстов и ordered tags на jobs
`62d27cd1-68a1-47ee-8ae6-10ea2abffa0a` (revision 2) и
`4a15a08f-745a-4163-854d-b8495b5aa018` (revision 1), с одним шаблоном
`MVP smoke 2026-09-03` и синтетической PNG-обложкой `cf-editorial-smoke.png`.
Проверены непрозрачный Dialog, видимые границы полей/actions, dirty reload с
явным подтверждением, валидация `12:46–42:46` как 30 минут и download Range
`206 / 1024 bytes`. Целые секунды в полях и placeholders больше не имеют `.000`.
Владелец дополнительно запросил улучшение отступов/группировки UI и отображение
таймкодов без миллисекунд, без изменения точности сохранённых границ.

Runtime проверен 2026-09-03: `MEDIA_WORKER_CONCURRENCY=1`, container limit 2 CPU.
Параллельный benchmark 2/4 ещё НЕ выполнен. 2026-09-03 в 21:06:42 UTC+7
отправлена пачка 4×30 минут для concurrency 1. Runner упал на Bash 3 `mapfile`,
а ошибочный EXIT handler пересоздал worker. Прогон НЕвалиден как performance
baseline. Новые пачки и переключения запрещены до независимого review runner.
DevOps сохраняет recovery/attempt evidence, не удаляя результаты; точный каталог:
`tmp/benchmarks/parallel-cut/level-1-20260903T210631+0700-b5524440-b600-40da-8eff-6370a21558cd/`.
Worker восстановлен с concurrency 1 / 2 CPU; четыре принятых job не подавать снова.
Независимо подтверждён Idle Sleep 21:12:02–21:12:49 (47 секунд) при lease 30s,
stable container и OOM=false. Это сильное объяснение повторного lease loss в том
окне, не доказательство причины каждого предыдущего expiry. Runner исправлен,
review CLEAN: 8 mocks + 4 независимых probes, сохранён `3994fa7`.
Единственный read-only monitor PID 23080; scoped `caffeinate -i -w 23080`
PID 32447, assertion завершается вместе с monitor. Перед действиями проверять
актуальность PID, не использовать broad kill. Текущую пачку не прерывать.
Три результата (`19cfc2af…`, `03584f46…`, `f8292dbe…`) READY; один
`c6052e33…` FAILED_FINAL после исчерпания retry budget. Пачка terminal, но
невалидна для performance comparison из-за runner incident и sleep. Продолжение:
AC power → scoped idle-sleep inhibition → чистый
level 1 → только после успеха level 2. На батарее новые прогоны запрещены.
Level 4 закрыт: расчетный budget ~8.07GiB выше текущих 7.75GiB Docker VM;
память VM автоматически не увеличивать. См. benchmark task для exact evidence.
Docker dependencies healthy, API и web запущены локально. После Stage 2a
worker пересобран и восстановлен с concurrency 1 / 2 CPU; API запущен из
актуального `dist` на `127.0.0.1:3001`, web — на `127.0.0.1:3000`.

## Первый следующий шаг

Следующий slice Stage 2a уже назначен `Backend Engineer — Montage assets`:
`docs/decisions/ADR-005-montage-assets-and-recipes.md` accepted после Architect
review; acceptance в `docs/engineering/tasks/stage2-montage-assets.md`.
Сначала ресурсы upload/probe/list/content; затем отдельный slice 2b recipes.
Live migrations/worker restart запрещены, пока capacity batch не завершён;
разработка и изолированные проверки не меняют работающий runtime.
Backend implementation и OpenAPI прошли independent CLEAN review: API 72,
worker 61, contracts 2, isolated PostgreSQL/HTTP 2; lint/typecheck/build,
Prisma validate, OpenAPI drift, formatting и diff check passed. Real disposable
FFprobe: H.264 MP4 принят, QuickTime MOV и corrupt input отклонены controlled.
Malformed UUID дают HTTP 400; `реклама.mp4` сохраняется без mojibake. Миграция
`20260903150000_montage_assets` применена к локальной рабочей базе 2026-09-06
после проверки пустой активной очереди. Live smoke CLEAN: H.264/AAC MP4
`интро-smoke.mp4` перешёл `PROBE_PENDING → READY` (640×360, 2000 ms,
audio=true), list/get сохранили результат, Range 0–1023 вернул 206/1024 B,
повтор с тем же idempotency key вернул тот же asset/job. Повреждённый MP4
завершился `FAILED_FINAL` с `SOURCE_PROBE_FAILED`; старый cut result после
миграции также вернул 206/1024 B. Frontend montage назначен
`Frontend Engineer — Montage Assets Workspace`; independent review и browser
smoke ещё не выполнены. После freeze OpenAPI — frontend, independent review и browser smoke. Фоновая сборка,
preview/approval/export следуют отдельно. Capacity concurrency `2`, затем `4`
остаётся отдельным измеряемым experiment после восстановления безопасного runner.

## Локальные данные

Не удалять и не загружать повторно без необходимости:
`/Users/mirai/Downloads/video-test.mp4` — `3813099228` bytes. Persistent MinIO
sources/results сохранять. Никогда не взаимодействовать с директориями
`seanova` или `dockerServer`.
