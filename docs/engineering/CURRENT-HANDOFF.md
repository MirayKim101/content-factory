# Content Factory — current handoff

Обновлено: 2026-09-09, восстановление Mac-кода и объединение Git.

## Главный результат

Mac snapshot `33f57c8` (`b13ea84` + 19 реальных незакоммиченных файлов) —
активная продуктовая основа. WSL `6e5097d` сохранён в истории и архиве как
альтернативная реконструкция. Решение: ADR-009. Итоговая интеграция сохраняет
обе Git-линии; основной код нельзя снова заменять WSL Stage 1.

Реклама, баннеры, CTA, intro/outro, ручные обложки, сборка, approval и ZIP export
уже реализованы. Предыдущая оценка «конец Stage 1» относилась к неполной копии
и не отражала recovered Mac project. Точный отчёт: `MAC-WSL-MERGE-REPORT.md`.

## Текущий этап

- Stage 1 и ручной Stage 2 реализованы; историческое Mac evidence сохранено.
- Stage 2B-1 backend foundation принят ранее. Его UI перенесён в состоянии WIP;
  две ошибки типов исправлены, но frontend acceptance не выполнен.
- Stage 2B-2…2B-6 и Stage 3 остаются впереди. AI generation/provider calls,
  Twitch, vertical и publishing при этом merge не добавлялись.
- `AI_CONTEXT_ENABLED` не включать до отдельной приёмки UI.

## Проверено и не проверено

Frozen install, Prisma validate/generate, typecheck/build и OpenAPI drift
проверены; lint и format также прошли. Финальная Docker-сборка worker успешна.
Независимый review merge adaptations и recovery-защит: CLEAN в ограниченном
объёме, см. `MAC-WSL-MERGE-REVIEW.md`.

Владелец явно разрешил пропустить тестовый этап: полный unit/integration/browser/
render/export/recovery suite этой объединённой версии не выполнялся. Это waiver
текущего merge, не утверждение CLEAN для будущих продуктовых slices.

## Runtime и данные

Старые API/web/WSL worker остановлены. Legacy PostgreSQL/Redis/MinIO и volumes
сохранены. Verified dump:
`tmp/recovery/before-mac-baseline-switch-20260909T144250Z.dump`.
Старый `.env` перемещён в `tmp/recovery/wsl-reconstruction.env`, mode 0600.
Активного `.env` нет: новый бинарник не должен подключиться к старой схеме.
Никаких Mac migrations к старой базе не применять, migration checksums не менять.

Следующий автономный шаг: выполнить изолированный local rollout по
`docs/infrastructure/mac-wsl-recovery.md`, затем закрыть QA Creator Context UI
по `tasks/stage2b-creator-context-qa.md`. Только после этого начать frames slice.
Временный integration worktree используется для сборки без изменения исходной
Mac-папки; статус основной ветки и финальный commit отражены в Git/Notion.

## Постоянные ограничения

Seanova и DockerServer в любом регистре, содержимое и связанные ресурсы полностью
исключены из работы. Полный доступ этого не отменяет. Исходная Mac-папка не
изменяется, её env/кэши/медиа не копируются в Git. Пользовательские `.idea/` и
root `package-lock.json` сохранены вне Git.

Владелец отменил прежний stop-at-50% для завершения этого merge и разрешил
использовать оставшуюся квоту. Расход всё равно минимизировать; не начинать
новые продуктовые задачи после завершения объединения и отчёта.
