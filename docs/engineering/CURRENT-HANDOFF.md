# Content Factory — current handoff

Обновлено: 2026-09-02
Ветка: `main`
Часовой пояс владельца: `Asia/Novosibirsk (UTC+7)`
Текущий сохранённый commit: `feat: add versioned source authorization`

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

## Проверки source authorization

- API unit: `32/32`;
- API integration: `33/33`;
- worker unit: `30/30`;
- worker PostgreSQL integration: `4/4`;
- web: `48/48`;
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

## Первый следующий шаг

Реализовать один вертикальный slice: последовательная очередь ручной загрузки
5–10 MP4, concurrency `1`, с отдельными real progress/server-finalization,
status, safe error и retry для каждого файла. Ошибка одного файла не должна
останавливать следующие. После реализации — independent review.

Затем: сохранённый horizontal operations/history screen, capacity baseline
`5 × 3` (каждый clip минимум 30 минут), templates/manual editorial package,
render overlays/intro/outro/audio, preview/approval/export, и только потом AI
Stage 2B.

## Локальные данные

Не удалять и не загружать повторно без необходимости:
`/Users/mirai/Downloads/video-test.mp4` — `3813099228` bytes. Persistent MinIO
sources/results сохранять. Никогда не взаимодействовать с директориями
`seanova` или `dockerServer`.
