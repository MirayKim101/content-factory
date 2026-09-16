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
- Stage 2B-1 принят: backend и восстановленный UI прошли независимую проверку,
  полный браузерный сценарий и проверку ручного fallback. Evidence:
  `CREATOR-CONTEXT-UI-REVIEW.md`, `CREATOR-CONTEXT-BROWSER-ACCEPTANCE.md`.
- Stage 2B-2…2B-6 и Stage 3 остаются впереди. Stage 2B-2 начат: утверждён контракт sparse-frame
  evidence и ведётся реализация с закрытым admission. Это ещё не принятый срез.
  Контракт: `tasks/stage2b-sparse-frame-evidence.md`; independent approval:
  `SPARSE-FRAME-CONTRACT-REVIEW.md`.
- `AI_CONTEXT_ENABLED=1` включён в restored API и dev UI. Это только профили,
  private reference, контекст и prompt; внешних AI calls и генерации нет.

## Проверено и не проверено

Frozen install, Prisma validate/generate, typecheck/build и OpenAPI drift
проверены; lint и format также прошли. Финальная Docker-сборка worker успешна.
Независимый review merge adaptations и recovery-защит: CLEAN в ограниченном
объёме, см. `MAC-WSL-MERGE-REVIEW.md`.

Владелец явно разрешил пропустить тестовый этап: полный unit/integration/browser/
render/export/recovery suite этой объединённой версии не выполнялся. Это waiver
текущего merge, не утверждение CLEAN для будущих продуктовых slices.

## Runtime и данные

Изолированная восстановленная среда запущена 2026-09-16 и прошла независимую
проверку. UI: `http://127.0.0.1:3000`, API: `127.0.0.1:3001`.
Новые контейнеры, сеть и тома имеют префикс `content-factory-restored`.
Порты зависимостей: 15432/16379/19000/19001. В новой базе применены 15 Mac
миграций; рабочий `.env` содержит только новые credentials, ignored, mode 0600.
Инструкция запуска и остановки: `docs/infrastructure/restored-runtime.md`.

Legacy PostgreSQL/Redis/MinIO и volumes сохранены. Старые API/web/WSL worker
остановлены. Старый env остаётся в `tmp/recovery/wsl-reconstruction.env`;
verified dump — `tmp/recovery/before-mac-baseline-switch-20260909T144250Z.dump`.
Никаких Mac migrations к старой базе не применять, migration checksums не менять.

API unit 128, worker unit 84, Creator Context API integration 2 и worker lease
integration 5 прошли. Интеграционные тесты выполнялись в отдельной одноразовой
`cf_acceptance_20260916`, не в рабочей restored базе. Независимый worker/runtime
review CLEAN. См. `RESTORED-WORKER-VERIFICATION.md`.

Manual assembly/approval/export flags включены только в новой local среде.
Ручной Stage 2 smoke дал видео с рекламой/баннером/CTA, обложку и ZIP с exact
revision. Его evidence: `RESTORED-MANUAL-PIPELINE-SMOKE.md`.
Creator Context UI принят независимо: 192 frontend tests, typecheck/lint/build,
OpenAPI drift и отдельные повторные проверки изменённых случаев. Полный live
сценарий create → private reload → upload → clear → default → context/prompt →
stale → explicit rebind → revoke → MANUAL ZIP прошёл без JS errors. ZIP сохранил
точную контрольную сумму. Dialog проверен обычными кликами при 1440×900 и
1280×720. MinIO allow/deny и ambiguous/terminal upload retry приняты отдельно;
backend/policy commit `b55bd5c` уже в origin/main. Старый failed reference очищен
startup reconciler без прямой правки DB. Данные synthetic fixtures сохранены.

Реальный SIGKILL/lease-expiry worker smoke также независимо воспроизведён:
вторая попытка завершилась READY, ровно один authoritative artifact, совпавшие
checksum и длительность. Evidence: `RESTORED-WORKER-RESTART-SMOKE.md`.

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
лимита** (70% использовано). Последний замер 2026-09-16 03:18 UTC: 30% использовано, 70% осталось.
Периодически проверять актуальную квоту; перед остановкой сохранить commit,
проверки, состояние сервисов и следующие действия. Старый waiver тестов касался
только merge; новые срезы проходят применимые проверки.

Полный доступ filesystem/network и Docker подтверждён 2026-09-16; это не
отменяет запрет внешних каталогов и их ресурсов. Изолированный rollout завершён. Текущая задача: контракт и реализация
Stage 2B-2 sparse-frame evidence по ADR-008 и MVP roadmap.

## Stage 2B-2 в работе

Один implementation owner меняет API/schema/worker, затем UI после OpenAPI
freeze. DevOps отдельно владеет узкой MinIO frame policy и её regression test.
Runtime migration, frame flag и новая policy пока не применены. Независимый
reviewer проверяет FFmpeg recipe и затем реальный diff. Deadline frame job
по умолчанию 300 секунд; истечение lease само по себе не освобождает slot.

Перед будущей миграцией сделан backup
`tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump`,
проверенный двумя полноценными restore в disposable DB. Подробности:
`SPARSE-FRAME-ROLLOUT-PREP.md`. Обе temporary restore DB удалены после проверки;
рабочая база не была restore target. Утверждённая предыдущая версия UI сохранена
в origin/main (`d266ff8`).
