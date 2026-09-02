# Content Factory — current handoff

Обновлено: 2026-09-02
Ветка: `main`
Часовой пояс владельца: `Asia/Novosibirsk (UTC+7)`
Текущий сохранённый commit: `HEAD feat: add manual editorial package backend`
Рабочее дерево после ночной фиксации: clean

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

Frontend для manual editorial draft намеренно не начинался: владелец попросил
зафиксировать состояние и остановиться до завтра.

## Первый следующий шаг

Завтра перед новым implementation slice восстановить состояние по этому handoff
и проверить `git status`, migration status и healthy containers. Затем передать
замороженный editorial OpenAPI contract одному `Frontend Engineer — Manual
Editorial Workspace`: добавить ручное редактирование title/description/tags,
загрузку/выбор собственной обложки и reload сохранённой revision на desktop
`/horizontal`. После browser smoke продолжить Stage 2 overlays/intro/outro/audio,
preview/approval/export. Capacity concurrency `2`, затем `4` — отдельный
измеряемый experiment, не смешивать его с frontend slice.

## Локальные данные

Не удалять и не загружать повторно без необходимости:
`/Users/mirai/Downloads/video-test.mp4` — `3813099228` bytes. Persistent MinIO
sources/results сохранять. Никогда не взаимодействовать с директориями
`seanova` или `dockerServer`.
