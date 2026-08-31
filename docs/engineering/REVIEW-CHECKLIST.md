# Independent review checklist

## Требования

- [ ] Прочитаны исходные acceptance criteria и обязательные документы.
- [ ] Проверен фактический diff, а не только отчёт implementer.
- [ ] Изменение не расширяет согласованный scope.
- [ ] Архитектурные границы соблюдены или существует одобренный ADR.

## Проверки

- [ ] Formatter/lint пройдены.
- [ ] Typecheck пройден.
- [ ] Unit/integration/contract tests пройдены по необходимости.
- [ ] Happy path воспроизведён.
- [ ] Controlled failure воспроизведён.
- [ ] Логи и ошибки понятны оператору.
- [ ] Документация соответствует поведению.
- [ ] Rollback реалистичен.

## Дополнительно для jobs и media

- [ ] Idempotency и duplicate prevention проверены.
- [ ] Retry, timeout и terminal failure проверены.
- [ ] Restart/reconciliation проверены.
- [ ] Временные файлы очищаются.
- [ ] Lineage и checksums сохраняются.
- [ ] Вход и результат проверены через ffprobe.

## Итог

- Findings с приоритетом и способом воспроизведения либо явное `no findings`.
- После исправлений выполнен re-check.
