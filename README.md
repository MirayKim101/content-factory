# Content Factory

Частный локальный конвейер подготовки горизонтальных и вертикальных видео.
Nuxt SPA, NestJS REST API, PostgreSQL, BullMQ, FFmpeg и private S3 storage.

## Текущее состояние

Восстановлена более свежая версия проекта с Mac вместе с её Git-историей и
несохранённым интерфейсом Creator Context. Ручной Stage 2 уже реализован:
обложки, метаданные, реклама, баннеры, CTA, intro/outro, сборка, подтверждение
и ZIP-экспорт. AI-генерация и автоматическая публикация ещё не реализованы.

- [Точный отчёт об объединении](docs/engineering/MAC-WSL-MERGE-REPORT.md)
- [Текущий handoff и следующий шаг](docs/engineering/CURRENT-HANDOFF.md)
- [Дорожная карта](docs/product/MVP-ROADMAP.md)
- [Архитектурное решение об объединении](docs/decisions/ADR-009-mac-wsl-baseline-reconciliation.md)

## Локальная разработка

Node.js 24.15.0 и pnpm 10.34.5. Зависимости восстанавливаются через
`pnpm install --frozen-lockfile`; новые версии библиотек не подменяются.

На WSL восстановленная версия запущена в отдельной среде: интерфейс
`http://localhost:3000`, API `http://localhost:3001`. Команды запуска и остановки:
[restored-runtime.md](docs/infrastructure/restored-runtime.md).
Старая WSL-база несовместима с восстановленной схемой; её данные и конфигурация
сохранены отдельно и не используются новым приложением. Подробнее:
[граница сред](docs/infrastructure/mac-wsl-recovery.md).

Полный прогон тестов при объединении пропущен по явному решению владельца.
После запуска 16 сентября повторно проверены API/worker и полный ручной Stage 2:
[проверка конвейера](docs/engineering/RESTORED-MANUAL-PIPELINE-SMOKE.md).
Creator Context UI принят: профили, права на фото, контекст исходника и
инструкция к нарезке, с сохранением ручного экспорта.
[Браузерная приёмка](docs/engineering/CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md).
Следующий этап — фоновое извлечение кадров. AI-провайдеры не подключены.
