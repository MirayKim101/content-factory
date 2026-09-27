# UI/UX и архитектурный аудит — 2026-09-27

## Результат

CRM-паттерны применяются к производственному workspace без имитации ещё не
существующей Stage 3 публикации. Основная модель остаётся прежней: источник →
нарезка → оформление → сборка → подтверждение → пакет для ручной публикации.

Исправлено в этом прогоне:

- AI research и thumbnail панели приведены к общим UI tokens, получили явную
  иерархию, loading/empty states и объяснение ручного решения;
- карточка контента показывает дату последнего изменения рядом с длительностью;
- панели перенесены из `widgets` в owning feature, чтобы feature не зависела от
  более высокого FSD-слоя;
- пустой assembly recipe нормализован в `null` на Vue Query boundary вместо
  запрещённого `undefined`;
- тест загрузки получил явный `NuxtLink` stub, чтобы предупреждения не скрывали
  реальные регрессии;
- roadmap синхронизирован с фактическим техническим acceptance Stage 2B-6.

## UX-ориентир

Из CRM-подхода используем только подходящие продукту принципы: компактная
постоянная навигация, сводные счётчики, видимая стадия работы, даты/свежесть,
контекстные действия в карточке, контролируемые ручные решения и быстрый переход
к следующему шагу. В отличие от классической CRM, тяжёлые media actions остаются
явными и fail-closed, а подтверждение точной revision нельзя заменить drag/drop.

Сверено с официальной документацией amoCRM: рабочий стол строится вокруг
ключевых показателей и событий, карточки воронки показывают task indicators, а
списочный режим допускает настраиваемые поля и сортировку:

- <https://www.amocrm.ru/support/desktop/blocks_of_desktop>
- <https://www.amocrm.ru/support/tasks/tasks_in_leads>
- <https://www.amocrm.ru/support/leads/setting_list_of_leads>

## Нужные навыки и инструменты

| Навык/инструмент | Когда нужен | Текущее состояние |
| --- | --- | --- |
| Обычная работа с кодом, тестами и Git | Весь pre-Twitch MVP | Доступно, отдельный skill не нужен |
| `computer-use` | Визуальная проверка 3100 на desktop/mobile и keyboard flow | Skill прочитан; при недоступном callable backend выполнен локальный Chromium render fallback |
| Browser E2E | Повторяемый smoke критических операторских сценариев | В проекте нет настроенного Playwright/Cypress gate; добавлять зависимость перед релизом без отдельного решения рискованно |
| `imagegen` | Только для будущих bitmap assets или эталонных обложек | Доступно, для code-native CRM UI не требуется |
| Security review/plugin | Перед внешней Stage 3 интеграцией и хранением credentials | Отдельный security plugin не установлен; текущие локальные gates остаются обязательными |
| OpenAI docs | Если будет выбран OpenAI provider | Доступно; до выбора provider не требуется |
| GitHub integration | PR/review automation | Не обязательна: текущий Git remote обслуживается CLI |

Создавать отдельный repo-specific Codex skill сейчас нецелесообразно: правила
архитектуры, портов, acceptance и безопасности уже централизованы в `AGENTS.md`,
ADR и handoff. Дублирование быстро разойдётся с authoritative документацией.

## Что блокирует следующий продуктовый gate

1. Реальный одинаковый manual/assisted operator benchmark по
   `STAGE2B6-OPERATOR-ACCEPTANCE.md` требует человека: это измерение внимания и
   решения, его нельзя честно заменить unit-тестом.
2. Полный keyboard/screen-reader smoke всё ещё требует человека или browser E2E
   harness. Desktop/mobile Chromium render выполнен, но он не измеряет качество
   операторского решения и assistive-technology flow.
3. Реальные Twitch media bytes и provider publication canary требуют выбранного
   gateway deployment и production OAuth credentials. Локальные Stage 3 paths
   остаются default-off и доказаны только через dry-run/adapter acceptance.

Остальная pre-Twitch техническая работа может продолжаться автономно при
сохранённых default-off admission flags и портах UI 3100 / API 3001.
