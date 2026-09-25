# Content Factory — current handoff

Обновлено: 2026-09-25. Продолжение сессии; защищённые каталоги и их ресурсы не затрагивались.

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
- Stage 2B-2 реализован и прошёл независимые проверки кода и restored-runtime
  live acceptance. Это принятый
  технический срез кадров; production admission остаётся feature-flagged.
  Контракт: `tasks/stage2b-sparse-frame-evidence.md`; independent approval:
  `SPARSE-FRAME-CONTRACT-REVIEW.md`.
- `AI_CONTEXT_ENABLED=1` включён в restored API и dev UI. Это только профили,
  private reference, контекст и prompt; внешних AI calls и генерации нет.
- Stage 2B-3 transcript foundation теперь имеет REST/OpenAPI, private
  content delivery с GET/HEAD/Range, отдельный `ai-transcript-v1` worker и
  restored-runtime smoke. Worker fenced по lease/deadline и повторно проверяет
  текущие source authorization, cut lineage, context/profile/prompt revisions
  перед READY. Media worker больше не потребляет AI-очередь. Дополнительный
  disposable PostgreSQL + private object-storage recovery smoke воспроизвёл
  READY, duplicate delivery, expired-lease restart и controlled retry
  exhaustion, а также удаление attempt-owned объекта при stale context;
  ambiguous PUT/COMMIT закрыты durable cleanup tombstone и периодическим
  reconciler; evidence: `TRANSCRIPT-WORKER-RECOVERY-ACCEPTANCE.md`.
- Stage 2B-4a теперь имеет durable PostgreSQL cited-research intent/citations/
  attempts/suggestion/cost, отдельную AI-worker очередь, reloadable operator UI
  и exact metadata apply. Сервер выводит `AI_ASSISTED` или `MIXED`, сохраняет
  thumbnail/provenance и отклоняет stale lineage. Admission остаётся выключен
  `RESEARCH_TEXT_ENABLED=0`; внешние providers не подключены. Disposable-DB
  smoke и независимый review реального diff — PASS/CLEAN; runtime rights policy
  повторно проверяется worker при claim и finalize.

- Stage 2B-5a принят: private deterministic no-likeness PNG candidates,
  restart-safe worker/cleanup, bounded content, exact apply, asset reuse и
  immutable thumbnail provenance прошли disposable PostgreSQL + ContentFactory
  MinIO smoke и независимый CLEAN review. Admission остаётся выключен по
  умолчанию.
- Stage 2B-6 integrated review/economics технически принят после независимого
  `CLEAN` review:
  additive exact snapshots, review/approval/export v2, v1 worker compatibility,
  deterministic five-entry manifest v2, generated client и integrated UI.
  Feature flag `EDITORIAL_INTEGRATED_REVIEW_ENABLED=0` по умолчанию; legacy
  manual revisions без explicit provenance продолжают только v1 путь. Exact
  component lineage/bytes, composite revision/provenance FKs, snapshot and
  economics fingerprint recomputation are enforced; historical AI/MIXED v1 is
  read-only and cannot enter a new export. Focused unit/UI/OpenAPI/ZIP checks,
  API isolated PostgreSQL `24/24`, worker PostgreSQL + real MinIO `29/29`,
  transcript isolated `4/4`, environment `9/9` и migration/schema parity
  проходят на Node 24.15. Approval read, export admission, worker claim и
  finalize повторно проверяют полную authoritative
  research/transcript/image/candidate lineage. До полного продуктового
  acceptance остаётся настоящий human operator benchmark одинакового
  manual/assisted сценария; scripted proxy не является заявлением об экономии.
  Authority/evidence:
  `tasks/stage2b-integrated-review-economics.md`.
  Re-review hardening additionally preserves the exact historical v1
  idempotency hash, snapshots only the declared citation subset in declared
  order without private excerpts, and canonicalizes manifest v2 bytes. Real
  repository manual/MIXED/AI_ASSISTED create/replay gates pass on disposable
  PostgreSQL; the documented timing comparison is explicitly a scripted proxy,
  not an efficiency claim.

## Проверено и не проверено

Frozen install, Prisma validate/generate, typecheck/build и OpenAPI drift
проверены; lint и format также прошли. Финальная Docker-сборка worker успешна.
Независимый review merge adaptations и recovery-защит: CLEAN в ограниченном
объёме, см. `MAC-WSL-MERGE-REVIEW.md`.

Владелец явно разрешил пропустить тестовый этап: полный unit/integration/browser/
render/export/recovery suite этой объединённой версии не выполнялся. Это waiver
текущего merge, не утверждение CLEAN для будущих продуктовых slices.

## Runtime и данные

Изолированная восстановленная среда прошла независимую проверку. Текущий UI:
`http://127.0.0.1:3100`, API: `127.0.0.1:3001`. Порт 3000 зарезервирован
владельцем для другого проекта и не используется Content Factory.
Новые контейнеры, сеть и тома имеют префикс `content-factory-restored`.
Порты зависимостей: 15432/16379/19000/19001. В рабочей базе применены все 29
миграций, включая transcript recovery и additive repair semantics для
`updatedAt`; Prisma status сообщает schema up to date. Перед rollout сделан и
полноценно восстановлен в disposable DB свежий backup; evidence:
`STAGE2B6-LOCAL-ROLLOUT.md`. Рабочий `.env` ignored, mode 0600.
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
лимита** (70% использовано). Владелец затем попросил остановиться раньше для перехода к другому проекту.
Последний замер 2026-09-22 13:43 UTC: 13% использовано, 87% осталось.
Периодически проверять актуальную квоту; перед остановкой сохранить commit,
проверки, состояние сервисов и следующие действия. Старый waiver тестов касался
только merge; новые срезы проходят применимые проверки.

Полный доступ filesystem/network и Docker подтверждён 2026-09-16; это не
отменяет запрет внешних каталогов и их ресурсов. Текущий checkpoint: реализация Stage 2B-2 sparse-frame evidence по ADR-008
с закрытым admission; сквозная приёмка отложена до следующего запуска.

## Stage 2B-2 в работе

Один implementation owner меняет API/schema/worker; после независимого OpenAPI
freeze root реализовал UI в непересекающихся файлах. DevOps отдельно владеет
узкой MinIO frame policy и её regression test.
Runtime migration и узкая frame policy применены только к restored среде.
`EDITORIAL_FRAMES_ENABLED=0`; frame jobs не запускались. Независимые проверки
extractor, API, persistence, worker, UI и configuration завершены CLEAN в своих объёмах. Deadline frame job
по умолчанию 300 секунд; истечение lease само по себе не освобождает slot.

Работа ведётся в ветке `feat/stage2b2-frame-evidence` в той же единственной
рабочей папке. `main` и `origin/main` сохраняют принятый checkpoint `53d13a6`.
Extractor прошёл независимый ограниченный review: 12 focused tests, worker
typecheck, 12 декодируемых JPEG на четырёх media fixtures и контролируемый
отказ для искажаемого tiny-anamorphic input. Evidence:
`SPARSE-FRAME-EXTRACTOR-REVIEW.md`. REST/OpenAPI contract также принят отдельно:
`SPARSE-FRAME-API-CONTRACT-REVIEW.md`. UI реализован, typecheck/lint/build и
211 frontend tests прошли; preliminary mocked-browser viewport check также
прошёл. После двух исправлений независимый frontend review CLEAN, 45 focused
tests/typecheck/lint повторены: `SPARSE-FRAME-UI-REVIEW.md`.
Persistence checkpoint также принят независимо, финальные 11 PostgreSQL integration tests
повторены: `SPARSE-FRAME-PERSISTENCE-REVIEW.md`. Worker orchestration и чистая установка всех 16 миграций проверены;
см. `SPARSE-FRAME-WORKER-REVIEW.md` и `SPARSE-FRAME-MIGRATION-PROOF.md`.
API suite: 138 PASS, worker suite: 114 PASS; full web suite: 211 PASS до
финальных UI fixes, после них независимые 45 focused tests/typecheck/lint PASS.
Live frame acceptance выполнен на подготовленном 28-секундном cut: один
idempotent POST/replay, READY с тремя JPEG, GET/HEAD/Range 206/416, checksum,
private headers и manual ZIP checksum до/после. Evidence:
`tmp/restored-runtime/frames-acceptance/state/evidence.json` (ignored, mode
0600). Stage 2B-2 принят в bounded local scope; Redis-loss and deadline
recovery remain separate follow-up checks.
PostgreSQL integration checks использовали disposable DB.

При восстановлении исчезнувшего worker достижение неизменяемого
`workDeadlineAt` также означает terminal `FRAME_WORK_DEADLINE_EXCEEDED` после
безопасного освобождения slot. Новая доставка не выдаёт истёкшей работе свежий
deadline. Подтверждённая fenced остановка до deadline допускает обычную
ограниченную retry policy. Следующий явный запрос оператора использует новый key.

Подготовлен отдельный synthetic no-reference context для 28-секундного cut
`90a42b66-f834-440e-a411-3b1b7b119eb2`; точные IDs и checksums находятся в
ignored `tmp/restored-runtime/frames-prep/evidence.json`. Старый ручной smoke fixture сохранён. Свежий backup перед rollout:
`tmp/recovery/content-factory-restored-pre-frame-rollout-20260916T042538Z.dump`,
SHA-256 `ee75746798fb66614c204f8730f6da9d19346dea182f3a707ae1641d3d0724b7`.
Полный restore проверен в disposable DB, затем она удалена. Файл ignored, 0600.

Перед будущей миграцией сделан backup
`tmp/recovery/content-factory-restored-pre-stage2b2-20260916T031258Z.dump`,
проверенный двумя полноценными restore в disposable DB. Подробности:
`SPARSE-FRAME-ROLLOUT-PREP.md`. Обе temporary restore DB удалены после проверки;
рабочая база не была restore target. Утверждённая предыдущая версия UI сохранена
в origin/main (`d266ff8`).

## Следующий запуск и расстояние до MVP

1. Сохранить все AI/integrated admission flags выключенными до отдельного
   rollout-решения; ручной Stage 2 путь остаётся рабочим.
2. Владелец выполняет одинаковый bounded manual и assisted сценарий через UI и
   фиксирует реальное foreground attention, wall clock, direct cost, mode и
   acceptance. Точный пошаговый лист: `STAGE2B6-OPERATOR-ACCEPTANCE.md`. Это
   последний незакрытый pre-Twitch product-acceptance gate.
3. Провести браузерный smoke текущего UI на порту 3100. Автоматизированный
   Windows computer-use из этой WSL-сессии не подключился, поэтому HTTP health
   и web `238/238` не заменяют визуальную операторскую проверку.
4. После human benchmark принять rollout/merge решение. Stage 3
   (Twitch/resumable ingestion, vertical pipeline, publishing и analytics)
   остаётся за текущей pre-Twitch границей.

Ручная реклама, ручные обложки и полный локальный horizontal pipeline уже
существуют. Техническая реализация pre-Twitch Stage 2B завершена; полный
продуктовый acceptance ожидает только действия из пунктов 2–3.

22 сентября остановленные ресурсы старого Compose-проекта `content-factory`
удалены точными именами: пять контейнеров, четыре тома, сеть и три старых
worker/runtime образа. Сохранены только `content-factory-restored` контейнеры,
сеть и три restored тома; `content-factory-minio` оставлен как общий образ
текущего runtime.

## Runtime checkpoint при остановке владельцем

Код и acceptance evidence сохранены коммитами `b0b00f1`, `94c1573`, `c4e7f4f`
и `47e50d3` в `feat/stage2b2-frame-evidence`.
API успешно восстановлен после исправления contracts native import; independent
review CLEAN. API session `26457`, PID `95151`, port 3001; root отдельно
подтвердил health `{"status":"ok"}`. AI context и frame admission включены
только в restored local runtime для acceptance. Profile/current prompt GET также
проверены DevOps.
Историческая web session использовала port 3000; этот checkpoint больше не
является текущим. Актуальный UI работает на 3100, а порт 3000 не трогать.
Worker healthy: container
`7d71b253002ca48ab9be822e4e72d964065c784128eea144473e3f93405e900a`.
Worker rebuilt from current frame code; API запускается native Node24. Новых
frame extraction jobs после принятого acceptance не создавали.

Последующие push после `b0b00f1` несколько раз завершались сетевым timeout;
remote сейчас подтверждён только до `b0b00f1`. Локальные commits сохранены;
первым Git-действием следующей сессии выполнить bounded
`git push -u origin feat/stage2b2-frame-evidence` и сверить remote SHA.

Финальная проверка DevOps: manual export
`f504af29-bc47-4a1d-ae74-821be80f939e` повторно скачан (246691 bytes), SHA
`14cb7a16d87687f917545e4eb99af6f1d62218590ab080b9d27a0b4c5f25e34a`
совпадает с принятым Stage 2. Exact frame POST вернул контролируемый
`503 EDITORIAL_FRAMES_DISABLED`, intent не создан. Evidence:
`tmp/restored-runtime/frames-acceptance/state/evidence.json` (ignored, mode
0600). Перед следующим recovery check сохранить current manual ZIP checksum;
все агенты закончили текущие задачи.
