# Сверка и объединение Mac → WSL — 9 сентября 2026

## Исправление предыдущего отчёта

Владелец был прав: ручная реклама и обложки уже реализованы. Предыдущий отчёт
описывал неполную GitHub/WSL-копию и ошибочно переносил её состояние на весь
проект. Полученная папка `C:\Users\stani\Downloads\ContentFactory` содержит
существенно более свежие исходники и локальные Git-коммиты, не попавшие в origin.

## Источники и сохранность

- Общий предок: `1dde0b41da57c6869a9c9414a451b0c9d7990af3`.
- WSL recovery: `6e5097d`, 10 коммитов после общего предка.
- Mac main: `b13ea84`, 36 коммитов после общего предка.
- Сверх Mac HEAD: 11 реально изменённых tracked-файлов и 8 новых файлов,
  преимущественно Creator Context UI, controller/OpenAPI и QA plan.
- 423 tracked-файла совпали с Mac HEAD побайтно. Массовый dirty status после
  переноса не означал переписанную кодовую базу; файловые mode differences не
  переносились как содержательные изменения. CRLF-only отличий не было.
- Все 19 реальных файлов сохранены отдельным snapshot commit
  `33f57c8b5f620b789dff011fab46a1d6b3be0263` до исправлений объединения.
- Исходная папка в Downloads не изменялась. Mac `.env`, зависимости, кэши,
  временные данные и symlinks не переносились. Защищённые каталоги исключены.

## Как выполнено объединение

При обычном merge Git выявил 50 конфликтующих путей. Главный конфликт был
семантическим: WSL независимо восстановил другие job/auth модели и миграции.
Согласно принятому ADR-009, целостной продуктовой основой выбран Mac snapshot.
Обе ветки сохранены как родители merge; история не заменяется squash/reset.

В активном коде находятся Mac Prisma schema/migrations, REST/OpenAPI,
`packages/contracts`, media-worker и Stage 2 UI. Альтернативные WSL migrations
от 20260909, `packages/manual-cut` и `packages/prisma-client` не смешиваются с
этой схемой. Их код доступен в Git recovery-ветке, а 14 документов сохранены в
`archive/wsl-reconstruction-20260909/` с явной отметкой об устаревшей основе.

Полезные изменения WSL адаптированы к текущему коду:

- строгий запрет Seanova/DockerServer сохранён в AGENTS.md и Docker build context;
- CI проверки generated Prisma адаптированы к пакету contracts;
- Docker context закрыт allowlist и исключает env, caches и защищённые имена;
- worker защищён от удаления уже принятого результата при потере ответа БД;
- S3 upload учитывает уже полученный AbortSignal;
- cleanup cut/probe scratch после аварии ограничен подтверждёнными terminal
  attempts и bounded batches;
- жизненный цикл consumer и readiness проверяются вместе, чтобы остановившийся
  обработчик не оставался формально здоровым.

Исправлены две ошибки TypeScript в перенесённом незавершённом Creator Context
UI. OpenAPI export теперь подготавливает inert environment до загрузки API и
не требует реального `.env`. Исторический blocker missing request bodies/path
parameters закрыт статической сверкой пяти PUT и matching generated contract;
это не заменяет frontend QA.

## Что действительно реализовано

| Возможность                                                                  | Фактическое состояние                                                            | Подтверждение в коде                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Загрузка, медиатека, несколько исходников, ручные диапазоны, фоновая нарезка | Реализовано в Mac Stage 1                                                        | media-pipeline, library/horizontal workspaces, process-media-job |
| Заголовок, описание, теги и собственная обложка                              | Реализовано без AI                                                               | editorial package API/UI, upload-thumbnail, private THUMBNAIL    |
| Реклама, intro/outro, баннеры и CTA                                          | Реализовано                                                                      | montage assets, assembly recipes, ffmpeg-assembly-renderer       |
| Сборка оформленного горизонтального видео                                    | Реализовано                                                                      | assembly render API/worker/UI                                    |
| Предпросмотр, подтверждение конкретной revision                              | Реализовано                                                                      | editorial approvals, review dialog                               |
| ZIP-пакет с видео, обложкой и metadata                                       | Реализовано                                                                      | streaming ZIP64 exporter, export API/card                        |
| Профиль автора, права на reference, контекст source/cut                      | Backend foundation принят по Mac evidence                                        | ai-content module, ADR-008, creator-context migration            |
| Интерфейс Creator Context                                                    | Перенесён незавершённым, ошибки типов исправлены, сборка проходит; QA не пройден | creator-context page/dialog/workspace, QA plan                   |
| Извлечение кадров, расшифровка, research, AI-тексты и AI-обложки             | Не реализованы как завершённые product slices                                    | Stage 2B-2…2B-6 roadmap                                          |
| Twitch, вертикальные AI-клипы, публикация, аналитика                         | Ещё впереди                                                                      | Stage 3 roadmap                                                  |

Наличие рекламы/обложки не означает AI-генерацию. Сейчас обложку можно загрузить
вручную, а рекламу/баннеры добавить в рецепт. AI provider calls и отдельного
AI-worker пока нет; feature flags не включались при объединении.

## Проверки этого объединения

Выполнены frozen-lockfile install, Prisma validate/generate, TypeScript checks,
сборка четырёх workspace-пакетов, API и web OpenAPI drift checks. Docker worker
собирается на Linux из закреплённых зависимостей. Финальная независимая проверка
ограничена реальным merge diff и переносом конкретных recovery-защит: CLEAN,
см. `MAC-WSL-MERGE-REVIEW.md`. Финальные lint и format: PASS. Docker image:
`sha256:7df487c59a07dd8506785bab78540690412e40be1804d677c553b60b416c356d`.
Prisma schema, миграции и lockfile совпадают с Mac snapshot; повторная генерация
Prisma меняет только форматирование, без содержательного drift.

По явному указанию владельца **не запускались полный unit/integration suite,
браузерные сценарии, реальные render/export и аварийные испытания этой версии**.
Исторические CLEAN/benchmark результаты Mac не выдаются за повторно полученные
на WSL. Старые 8 незакрытых тестов WSL относятся к альтернативной реконструкции,
а не являются автоматически текущим списком требований к восстановленной базе.

## Данные и работающая среда

Новая схема не применялась к несовместимой WSL-базе. Старые API/web/worker
остановлены, writers отсутствовали при verified dump:
`tmp/recovery/before-mac-baseline-switch-20260909T144250Z.dump`.
Старый env сохранён как `tmp/recovery/wsl-reconstruction.env`, mode 0600;
активного `.env` нет. PostgreSQL/Redis/MinIO и media volumes не удалены.

Этот merge восстанавливает код и Git-историю, **не выполняет live rollout**.
Точный следующий шаг запуска — `docs/infrastructure/mac-wsl-recovery.md`:
отдельная пустая база и storage namespace либо совместимый Mac backup.

## Правильная оценка расстояния до MVP

Мы на переходе от реализованного ручного Stage 2 к AI-assisted Stage 2B.
Сначала завершаются приёмка Creator Context UI и подготовка совместимой local
среды. Затем Stage 2B-2 frames, 2B-3 transcript/AI worker, 2B-4 research/text,
2B-5 thumbnail suggestions, 2B-6 integrated approval/export/economics.
После этого — Stage 3: Twitch, vertical, publication и analytics для 1–2 каналов.
Полный MVP ещё не готов; реклама и ручные обложки повторной реализации не требуют.
