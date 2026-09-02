# Stage 1 — UX ручной нарезки видео

Статус: ready for implementation
Дата: 2026-09-02
Владелец UX: Frontend Engineer — Stage 1 Cutting UX

## Цель и границы

Это desktop-first private-admin экран для уже загруженного и готового MP4.
Оператор выбирает текущий исходник, смотрит его во встроенном HTML video player,
задаёт один или несколько независимых отрезков с точными миллисекундами и
отправляет их в фоновую обработку. Затем он наблюдает за каждым адресным job и
скачивает готовый горизонтальный MP4.

В Stage 1 не входят: timeline с перетаскиванием, thumbnails/waveform, монтаж
между отрезками, вертикальное видео, AI, overlays, публикация и удаление
исходника. Отрезки не склеиваются: один segment создаёт один результат и один
адресный job. Максимум сегментов в одном submit задаётся API (`maxSegmentsPerRequest`);
если поле не появится в первой версии контракта, UI использует явно
документированный server limit и показывает ответ validation error без потери
черновика.

## Основной пользовательский путь

1. После `SOURCE_READY` экран загрузки показывает ссылку-кнопку «Перейти к
   нарезке». Она открывает `/cuts?projectId={projectId}`. Это и есть «текущий
   загруженный source» для первого MVP; проект не выбирается по имени из
   несуществующего пока общего списка.
2. При прямом открытии `/cuts` экран показывает селектор «Исходное видео».
   В MVP он принимает `projectId` из URL или даёт поле UUID и кнопку
   «Открыть видео». После появления project list оно заменит ручной ввод,
   сохранив URL как shareable/reload-safe state. Нельзя молча выбрать
   «последний» файл из localStorage.
3. UI получает безопасный project/source DTO. Пока `source.status !== READY`
   или project не `SOURCE_READY`, player и editor disabled, а причина видна.
4. После metadata player UI получает конечную `durationMs` из probe DTO и
   включает редактор. Кнопки «Установить начало» и «Установить конец» берут
   фактическую `video.currentTime`, округляют до ближайшей миллисекунды и
   записывают соответственно `startMs`/`endMs` активного сегмента.
5. Оператор исправляет поля в формате `чч:мм:сс.ммм`, добавляет/удаляет
   сегменты, видит локальную валидацию и отправляет только валидный список.
6. Submit создаёт jobs в PostgreSQL и возвращает их адресные DTO. UI сохраняет
   job IDs в URL (`?projectId=…&jobs=id,id`) и начинает polling именно этих jobs.
   Перезагрузка восстанавливает экран только через URL и GET API, не через
   неавторитетный browser state.
7. Когда все jobs terminal, готовые строки дают «Скачать MP4», а ошибочные —
   безопасную причину и «Создать новый отрезок с этими границами». Последнее
   действие копирует границы в новый черновой segment; retry того же job в
   Stage 1 не предполагается, пока API не введёт явную идемпотентную retry
   команду.

## Wireframe

```text
┌ Content Factory / Нарезка видео ──────────────────────────────────────────┐
│ Исходное видео [Название проекта / UUID                         v] Открыть │
│ source.mp4 · 3.55 GiB · Длительность: 02:00:00.000 · Готов к нарезке       │
├─────────────────────────────────────────────┬──────────────────────────────┤
│                                             │ Отрезки                       │
│              [ встроенный video ]           │ 1  Начало [00:12:04.250]      │
│                                             │    Конец   [00:13:31.500]      │
│ Текущая позиция: 00:12:04.250                │    Длительность: 01:27.250    │
│ [Установить начало] [Установить конец]       │    [Удалить]                  │
│ Подсказка: пробел — воспроизведение/пауза.   │ ────────────────────────────  │
│                                             │ [+ Добавить отрезок]          │
│                                             │                               │
│                                             │ [Запустить нарезку (1)]        │
├─────────────────────────────────────────────┴──────────────────────────────┤
│ Задания обработки                                                       │
│ Отрезок 1 · 00:12:04.250–00:13:31.500 · В очереди                         │
│ Ожидает свободный слот обработки. Обновлено только что.                  │
│ [Обновить сейчас]                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

На ширине менее 1024 px области становятся одной колонкой: player, затем
редактор, затем jobs. Primary button остаётся после списка сегментов, не
становится floating и не перекрывает native video controls. Минимальная
поддерживаемая ширина — 320 CSS px; поля и действия на строке переносятся,
не требуют горизонтальной прокрутки. На desktop (>=1024 px) player занимает
примерно две трети рабочей области, editor — одну треть. Видео сохраняет aspect
ratio и не обрезается.

## Редактор сегментов

### Модель черновика

`SegmentDraft` принадлежит feature и содержит только:

```text
clientKey: stable local UUID
startText: "00:12:04.250"
endText: "00:13:31.500"
startMs?: integer
endMs?: integer
validation: field-level errors derived from parsed values
```

`startMs`/`endMs` — единственные значения, отправляемые API. Формат отображения
всегда нулепаддированный `HH:MM:SS.mmm`; часы не ограничены 23. Ввод принимает
также `MM:SS`, `MM:SS.m`, `HH:MM:SS` и нормализуется при blur/Enter. Пустое,
отрицательное, нечисловое или имеющее более трёх знаков миллисекунд значение не
нормализуется: пользователь видит ошибку рядом с полем и исходный текст, чтобы
не потерять ввод. Значение `00:00:00.1` означает ровно 100 ms, а не 1 ms.

При создании первого segment поля пусты. «Добавить отрезок» добавляет пустую
строку и переводит фокус на её «Начало». Активным segment является последний
сфокусированный segment; кнопки player записывают время только в это поле.
Если фокус ещё не был выбран, кнопка ставит время в первый незаполненный segment,
а при его отсутствии создаёт новый и сообщает это через live region. Кнопка
`Установить начало` не изменяет конец и наоборот. Если действие создаёт
`startMs >= endMs`, это допустимый временный черновик, но валидация блокирует
submit. «Удалить» требует подтверждения лишь когда строка содержит значения;
после удаления фокус переходит к кнопке «Добавить отрезок» или заголовку
предыдущего segment.

### Локальная валидация

Проверяется после blur, перед submit и после установки точки player (не на
каждом нажатии клавиши):

| Правило                         | Текст рядом с полем / формой                           |
| ------------------------------- | ------------------------------------------------------ |
| нет ни одного непустого segment | «Добавьте хотя бы один отрезок.»                       |
| одно из полей пусто             | «Укажите начало и конец отрезка.»                      |
| формат не распознан             | «Введите время, например 00:12:04.250.»                |
| `startMs < 0`                   | «Начало не может быть раньше 00:00:00.000.»            |
| `startMs >= endMs`              | «Конец должен быть позже начала.»                      |
| `endMs > durationMs`            | «Конец выходит за длительность исходного видео (… ).»  |
| две одинаковые пары             | «Этот отрезок уже добавлен.»                           |
| лимит segment API превышен      | «За один запуск можно обработать не более N отрезков.» |

Пересекающиеся, но не идентичные segments разрешены: это отдельные сознательно
заказанные результаты. Отправка недоступна, пока имеется хотя бы одна ошибка,
нет известной `durationMs`, source не READY или mutation pending. Кнопка имеет
короткое объяснение через visible text/`aria-describedby`, а не только disabled
состояние.

Сервер остаётся авторитетной защитой: UI отображает field errors из его
валидационного ответа и не создаёт job при reject. Если актуальная probe
длительность изменилась или source стал недоступен, UI заменяет локальные
предположения server response и предлагает исправить черновик.

## API contract, необходимый UI

Имена endpoint ниже описывают требуемую семантику, а не обходят утверждение
OpenAPI. Точные generated operation names принадлежат API contract implementer;
frontend импортирует только generated DTO/types через один typed adapter.

| Данные / операция                   | Минимум для интерфейса                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET project by projectId`          | `id`, `name`, `status`, source `id/status/originalFilename/sizeBytes`, probe `durationMs` (integer, nullable до probe), источник доступен ли для безопасного stream/download.                                                                                                                                               |
| безопасный source playback endpoint | Browser-playable MP4 response с `Accept-Ranges`/`Content-Range`, `Content-Type: video/mp4`, без object key и storage credentials. Не отдавать presigned storage URL в DTO.                                                                                                                                                  |
| create cuts                         | body: `projectId`, `segments: [{ clientSegmentId, startMs, endMs }]`; header `Idempotency-Key`; response: исходный request identity и `jobs: [{ id, clientSegmentId, revision, state, startMs, endMs, … }]`. Одинаковый key и byte-identical body возвращают тот же logical jobs; иной body даёт safe idempotency conflict. |
| `GET job by id`                     | `id`, `revision` (монотонный), `state`, segment bounds, queue reason если есть, `progress` только с доказуемыми fields, `updatedAt`, `attempt`, safe `failure` (`code`, user-safe `message`, retryability), ready artifact metadata.                                                                                        |
| safe result download endpoint       | attachment/stream `video/mp4` для конкретного ready job, с безопасным именем файла; `404/409` если результат ещё не готов или недоступен.                                                                                                                                                                                   |

`progress` не превращается в выдуманный процент. Допустимые представления:

- queued: `queuePosition` только если он действительно рассчитан, иначе queue
  reason и количество occupied/configured media slots;
- processing: `processedMs` и `totalMs`, когда FFmpeg реально предоставляет
  оба значения; UI показывает `Обработано 00:… из 00:… (NN%)` и progressbar;
- processing без измерения: indeterminate progressbar и «Обработка началась.
  Точный прогресс пока недоступен.»;
- готово/ошибка: progressbar terminal, без дальнейшей анимации.

Polling использует Vue Query keyed `['pipeline-job', jobId]`. Пока хотя бы один
job non-terminal, refetch interval — 2 s для `PROCESSING`, 5 s для `QUEUED`;
в hidden tab — не чаще 15 s. После terminal state polling останавливается.
Ответ применяется только если `revision >= cachedRevision`; более старый ответ
игнорируется. «Обновить сейчас» делает один query refetch. Сетевой сбой polling
не стирает последний известный state: строка получает non-blocking message
«Не удалось обновить статус. Показаны данные на …», автоматически retry с
bounded backoff и доступной кнопкой обновления.

`POST create cuts` получает idempotency key на один неизменённый submit из
feature-owned idempotency adapter. Повтор после network-unknown использует тот
же key и тот же нормализованный body. Любая правка segments создаёт новый key;
двойной click во время pending не создаёт второй request. После успешного
ответа UI не отправляет прежний черновик повторно: он создаёт чистый editor и
показывает returned jobs.

## Состояния и русская microcopy

| Состояние                     | Видимое содержание и действие                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| нет `projectId`               | «Выберите загруженное видео, чтобы начать нарезку.» Поле UUID, «Открыть видео».                                                                                          |
| загрузка project/source       | Skeleton заголовка, player и editor; текст «Загружаем сведения об исходном видео…».                                                                                      |
| project/source не готов       | «Исходное видео ещё не готово к нарезке.» Показать API-safe status и «Обновить сейчас»; editor disabled.                                                                 |
| отсутствует/недоступен source | «Не удалось открыть исходное видео. Оно могло быть перемещено или ещё не сохранено.» «Обновить сейчас» и безопасный code/details.                                        |
| metadata ещё нет              | «Проверяем длительность видео. Поля времени станут доступны после проверки.» Indeterminate progress, без процента.                                                       |
| пустой editor                 | «Добавьте первый отрезок: укажите начало и конец или поставьте их на плеере.»                                                                                            |
| корректный editor             | `Запустить нарезку (N)`; ниже: «Будет создано N независимых заданий. Обработка идёт в фоне.»                                                                             |
| submit pending                | Button: «Создаём задания…»; editor read-only, cancel browser navigation не блокируется.                                                                                  |
| network-unknown submit        | «Мы не знаем, получил ли сервер запрос. Повторите с теми же границами — дубликаты не будут созданы.» Button «Проверить/повторить запрос».                                |
| queued                        | Tag «В очереди»; «Ожидает свободный слот обработки.» При наличии: «Занято слотов: 1 из 1.»                                                                               |
| processing measurable         | Tag «Обрабатывается»; «Обработано 00:42.000 из 01:27.250 (48%).» Determinate progressbar.                                                                                |
| processing indeterminate      | Tag «Обрабатывается»; «Обработка началась. Точный прогресс пока недоступен.» Indeterminate progressbar.                                                                  |
| ready                         | Tag «Готово»; «MP4 готов к скачиванию.» `Скачать MP4`; filename/size если API их вернул.                                                                                 |
| final failure                 | Tag «Не обработано»; server-safe message, code в `<details>` для оператора, «Создать новый отрезок с этими границами». Ни object/storage/FFmpeg command, ни stack trace. |
| polling error                 | Non-blocking Message `role=status`; последний verified status остаётся доступен.                                                                                         |

Для групповой отправки partial result не маскируется: успешные job cards сразу
показываются, а не созданные server-validated segments получают inline errors с
сохранённым черновиком. Контракт обязан различать atomic reject от per-segment
accepted/rejected result; MVP предпочтительно использует atomic validation всей
команды, затем создаёт все jobs. Если backend выбирает partial acceptance, это
должно быть явно отражено в OpenAPI response и UI в сообщении
«Создано N из M заданий. Исправьте остальные отрезки и отправьте их отдельно.»

## Accessibility

- Использовать native `<video controls>` с текстовым `<track kind="captions">`,
  когда source содержит доступные captions; отсутствие captions не подменять
  фиктивными. Player получает понятный accessible name «Просмотр исходного
  видео: {filename}».
- Все действия — реальные `<button>`, поля имеют `<label>`, ошибки связаны
  через `aria-describedby`, invalid fields получают `aria-invalid="true"`.
- Изменение результата «Установить начало/конец» объявляется через один
  `aria-live="polite"` region: «Начало отрезка 2 установлено: 00:12:04.250».
  Не объявлять каждый polling tick; terminal transitions объявлять однократно.
- Status tags имеют текст, а не только цвет. Progressbar имеет `aria-label`,
  `aria-valuemin/max/now` при измеримом прогрессе; indeterminate status говорит
  словами, что процент неизвестен.
- Клавиатура: Tab проходит логично от player к marker buttons, сегментам,
  submit и jobs; Enter в time input нормализует его, Space в focused button
  работает нативно. Не перехватывать пробел глобально, чтобы не ломать ввод.
- Контраст, focus ring, target не менее 44x44 px для touch-like controls;
  ошибки не зависят только от цвета. `prefers-reduced-motion` отключает
  декоративную анимацию, но не обновление данных.
- Download остаётся обычной доступной ссылкой/кнопкой; состояние download
  browser-managed и не выдаётся за job progress.

## FSD component boundaries

```text
app/pages/cuts.vue                         route composition: validates query,
                                            renders widget only
widgets/video-cutting-workspace/           source header + player/editor/jobs layout
features/select-cut-source/                projectId form, query navigation
features/edit-cut-segments/                SegmentDraft, Zod time parsing,
                                            set markers, add/remove/validate
features/submit-video-cuts/                mutation, idempotency and response handoff
features/download-cut-result/              safe generated-client download action
entities/project/                          project/source presentation mapping
entities/video-source/                     duration/availability/format helpers
entities/pipeline-job/                     job state mapping, Vue Query polling,
                                            monotonic-revision guard
shared/api/                                generated client plus one typed adapter;
                                            no component HTTP
shared/ui/                                 project wrappers around PrimeVue/native
                                            controls, TimecodeInput, StatusTag,
                                            AccessibleProgress
```

Allowed imports are strictly `pages -> widgets -> features -> entities -> shared`.
The widget may compose features and entities but cannot make API calls. Vue Query
is the sole owner of project/job server state; Pinia is unnecessary for the
first screen. A future durable, client-only unsent cut draft may use a narrow
Pinia store only after an explicit product decision; initial MVP deliberately
does not promise recovery of unsubmitted media edits.

## Acceptance tests

### Unit/component

1. Time parser normalizes accepted inputs to exact integer ms, including
   `00:00:00.1 -> 100`; rejects negative, malformed and >3 decimal positions.
2. Duration validation blocks `startMs >= endMs` and `endMs > durationMs`, but
   permits overlapping non-identical segments.
3. Marker buttons use player current time rounded to integer ms and update only
   the active target field; their live announcement contains formatted time.
4. Empty, source-pending, metadata-pending, validation, mutation-pending,
   queued, both processing types, ready, final failure and polling-error states
   render the stated Russian copy and semantic controls.
5. Repeated click while submit pending makes one mutation; network-unknown retry
   reuses the idempotency key; changed segment values get a new key.
6. A stale job response with lower revision cannot replace newer ready/failure
   UI; terminal job stops its polling interval.
7. Invalid fields expose label, `aria-invalid` and linked error; all status
   semantics remain available without colour.

### Browser smoke

1. Upload a small known-good horizontal MP4, follow «Перейти к нарезке», wait
   for real probe duration and set start/end using player at known positions.
2. Edit the resulting human-readable times, create two valid segments, submit
   once and reload the returned jobs URL while one is queued/processing.
3. Observe each status reach `READY`; download each MP4; verify browser plays
   it and `ffprobe` duration is within the documented encoding tolerance of
   `endMs - startMs`.
4. Submit an end beyond source duration and verify no job is created plus a
   field-level controlled message. Repeat with a corrupted MP4 and verify final
   safe failure, no endless spinner and no storage internals in the browser.
5. Throttle/offline the job-status request after a known state and verify that
   the visible last state remains, the stale-data notice appears, and manual
   refresh is keyboard accessible.

## Implementation notes and out-of-scope decisions

- Probe duration is a backend-owned, authoritative media fact; browser
  `video.duration` may improve the player display but must never relax server
  validation or be the sole source for `durationMs`.
- The source playback route must support range requests, otherwise seeking in a
  two-hour source is not acceptable for this UX. Its authorization semantics
  remain private-infrastructure scope of ADR-001.
- No synthetic ETA: only show it if the API supplies one with an explicit
  confidence/measurement definition. Current copy intentionally omits it.
- No task controls (cancel, retry, priority) are designed here because their
  durable semantics are not in the Stage 1 contract. Adding visible controls
  without those semantics risks duplicate output or unsafe recovery.
- New UI code must use project wrappers around PrimeVue/native controls and
  generated OpenAPI types; this document does not authorize a raw `fetch`, a
  new dependency, or a backend contract change by the frontend implementer.
