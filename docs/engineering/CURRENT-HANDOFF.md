# Content Factory — current handoff

Обновлено: 2026-09-16, продолжение после объединения Mac-кода.

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
Временный `ContentFactory-merge` удалён 2026-09-16 штатной командой
`git worktree remove` после проверки чистого дерева и совпадения HEAD с main
(`aae651c`). Уникальных исходников или локальных данных в нём не было, только
зависимости и результаты сборки. Единственная рабочая папка — `ContentFactory`;
ветки import/integration/recovery и обе истории сохранены.

## Постоянные ограничения

Seanova, Seanova-new и DockerServer в любом регистре, содержимое и связанные ресурсы полностью
исключены из работы. Полный доступ этого не отменяет. Исходная Mac-папка не
изменяется, её env/кэши/медиа не копируются в Git. Пользовательские `.idea/` и
root `package-lock.json` сохранены вне Git.

С 2026-09-16 владелец поручил продолжать автономно до остатка **30% недельного
лимита** (70% использовано). Последний начальный замер: 6% использовано.
Периодически проверять актуальную квоту; перед остановкой сохранить commit,
проверки, состояние сервисов и следующие действия. Старый waiver тестов касался
только merge; новые срезы проходят применимые проверки.

Полный доступ filesystem/network и Docker подтверждён 2026-09-16; это не
отменяет запрет внешних каталогов и их ресурсов. Текущая задача: изолированный
rollout восстановленной версии, затем завершение Creator Context UI.
