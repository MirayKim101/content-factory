# Stage 1.5 — медиатека и рабочее место горизонтальных видео

Статус: ready for implementation after API contract approval

Дата: 2026-09-02

Владелец UX: Frontend Engineer — Media Library & Horizontal Workspace UX

## Цель и границы

После Stage 1 оператору не нужно открывать один проект, возвращаться назад и
повторять этот путь для каждого файла. Stage 1.5 создаёт одно рабочее место для
нескольких загруженных горизонтальных источников:

```text
Медиатека (все исходники)
-> выбрать один или несколько готовых источников
-> Горизонтальные видео
-> задать пары таймкодов у каждого источника
-> создать независимые MP4 и скачать их
```

`Project` остаётся техническим контейнером `1:1` для `VideoSource`. Медиатека
— это read projection проектов и исходников: она не создаёт второй тип сущности,
не дублирует файлы и не раскрывает object-storage keys.

Входят: persistent navigation, медиатека с выбором, последовательная очередь
ручных загрузок пяти и более файлов, рабочее место с несколькими источниками,
точные таймкоды, один активный player, статусы и скачивание результатов.

Не входят: вертикальная обработка, AI, поиск моментов, timeline/waveform,
удаление источника, монтаж между роликами, overlays, публикация, resumable
multipart upload и общий атомарный запуск нарезок нескольких источников.
Вертикальный workflow остаётся Stage 3.

## Информационная архитектура

У приложения есть persistent sidebar на desktop. Он доступен на `/`, `/library`
и `/horizontal`; `/cuts?projectId=...` сохраняется как совместимый Stage 1
deep-link и позже перенаправляется в `/horizontal` с тем же выбором.

| Раздел                 | URL                                 | Назначение                                         | Доступность                                           |
| ---------------------- | ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `Горизонтальные видео` | `/horizontal?projectIds={uuid,...}` | Выбранные источники, таймкоды, задания, результаты | доступен                                              |
| `Медиатека`            | `/library?…`                        | Все исходники, поиск, выбор, загрузка              | доступен                                              |
| `Вертикальные видео`   | —                                   | Будущий AI/vertical pipeline                       | disabled, `aria-disabled=true`, «Появится на Этапе 3» |

Текущий MVP проектируется и принимается только для desktop. Отдельная мобильная
навигация и drawer отложены в интерфейсный backlog.

## Медиатека

### Список и выбор

Медиатека показывает постраничный список: имя проекта, MP4, размер, дату,
длительность после probe, безопасный status и счётчики созданных/готовых/ошибочных
cut jobs. Поиск работает по проекту и имени файла. Фильтры принадлежат URL,
например `/library?q=stream&status=SOURCE_READY`.

В строке есть checkbox «Выбрать видео». Можно выбрать 5+ файлов, максимум 20:
это ограничение совпадает с deep-link и защищает интерфейс от неуправляемого
экрана. Не `SOURCE_READY` или не авторизованный источник виден, но не
выбирается: checkbox disabled и причина показана рядом. До перехода выбор — временное состояние страницы;
после перехода источником истины становится `projectIds` в URL.

Панель действий после выбора: «Выбрано: N» и «Открыть в горизонтальных видео».
Она ведёт на `/horizontal?projectIds={id1,id2,...}` в порядке выбора. Ссылку
можно копировать, открывать и обновлять: данные восстанавливаются по query и
API, не из localStorage.

### Очередь загрузки

Действие «Загрузить видео» открывает inline panel: имя проекта и MP4. В
production/manual policy готовый файл показывает `NOT_REVIEWED`, и отдельный
диалог подтверждает права только для текущей версии. В explicit local-auto
profile backend сразу создаёт local-only решение, поэтому диалог не появляется.
«Добавить ещё файл» создаёт очередь строк. Оператор выбирает один или
пять+ файлов, но одновременно выполняется ровно одна HTTP-загрузка
(`concurrency = 1`), без конкуренции за сеть и локальные ресурсы.

Каждая строка показывает filename, размер, project name, status, реальный XHR
progress `loaded / total / NN%`; после `loaded === total` отображает отдельный
indeterminate status «Сервер проверяет и сохраняет файл», а не ложные `100%`.
У ожидающей строки есть «Убрать из очереди». У активной нет обещанной отмены,
пока API не определит abort semantics. Ошибка одной строки не останавливает
следующие: есть safe error и «Повторить эту загрузку». После `SOURCE_READY`
появляется «Выбрать для горизонтальных видео».

### Состояния

| Состояние            | Видимое содержание                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------- |
| initial loading      | skeleton строк и «Загружаем медиатеку…»                                                   |
| empty                | «Медиатека пока пуста. Загрузите первый MP4, чтобы начать работу.»                        |
| loading next page    | «Загружаем ещё видео…»; уже полученные строки не исчезают                                 |
| query error          | «Не удалось обновить медиатеку. Показан последний полученный список.» и «Обновить сейчас» |
| no search results    | «По этому запросу видео не найдено.» и «Сбросить поиск»                                   |
| source/probe pending | safe status, disabled выбор, «Обновить сейчас»                                            |
| upload queued        | «В очереди загрузки»                                                                      |
| upload measurable    | «Загружено 42% — 840 МБ из 2 ГБ.» и determinate progressbar                               |
| finalization         | «Файл отправлен. Сервер проверяет и сохраняет его.» и indeterminate progressbar           |
| upload failure       | safe error и «Повторить эту загрузку»; соседние строки продолжаются                       |

## Рабочее место «Горизонтальные видео»

### Выбор и deep-link

`projectIds` — comma-separated UUID в `/horizontal?projectIds=…`, максимум 20.
Не UUID, дубликаты и лишние IDs удаляются при normalisation query; показывается
non-blocking сообщение «Некоторые ссылки на видео недействительны и не были
открыты». Порядок IDs стабилен и определяет порядок source rows.

Экран запрашивает summary и detail каждого выбранного project. Недоступные,
несуществующие или pending источники остаются отдельной строкой с причиной и
«Убрать из рабочего места»; готовые строки не блокируются. При пустом query
видны empty state и «Выбрать видео в медиатеке». «Добавить видео» открывает
медиатеку с `returnTo=/horizontal?...`; подтверждение возвращает объединённый,
deduplicated набор.

Desktop workspace показывает grid независимых карточек. В каждой разрешённой
карточке есть собственный native video player; PrimeVue не предоставляет media
player, поэтому это намеренное исключение. Одновременно воспроизводится не более
одного видео. Кнопка PrimeVue «Настроить нарезки» открывает один Dialog для
выбранного source. Таймкоды/jobs принадлежат source и не теряются при закрытии
или переключении диалога.

### Desktop wireframe (>= 1024 px)

```text
┌──── Content Factory ────────────────┬──────────────────────────────────────────────┐
│ [▣] Горизонтальные видео            │ Горизонтальные видео    [Добавить видео]     │
│ [▤] Медиатека                       │ Выбрано: 5 источников                       │
│ [▯] Вертикальные видео               ├──────────────────────────────────────────────┤
│     Появится на Этапе 3              │ ┌─ Карточка 1 ─────┐ ┌─ Карточка 2 ─────┐ │
│                                      │ │ [video 16:9]     │ │ [video 16:9]     │ │
│                                      │ │ [Настройки]      │ │ [Настройки]      │ │
│                                      │ └────────────────┘ └────────────────┘       │
│                                      │ ┌─ Карточка 3 ─────┐ ┌─ Карточка 4 ─────┐ │
│                                      │ │ [video 16:9]      │ │ [video 16:9]      │ │
│                                      │ │ [Настройки]       │ │ [Настройки]       │ │
│                                      │ └───────────────────┘ └───────────────────┘ │
│                                      │ Dialog: player, markers, segments, submit   │
└──────────────────────────────────────┴──────────────────────────────────────────────┘
```

Sidebar занимает 224–272 px. Рабочая область использует desktop grid: 2 колонки
на базовой ширине, 3 на широком экране и 4 от 1600 px. Пятая карточка переносится
в следующий ряд. Карточки не фиксируются и не перекрывают native controls.

### Mobile — deferred

Отдельная mobile-версия, drawer-навигация, touch-layout и приёмка на ширине
320–1023 px не входят в текущий MVP. Desktop-интерфейс не должен аварийно
ломаться при уменьшении окна, но mobile-specific UX будет спроектирован и
проверен отдельным срезом.

### Карточка источника и Dialog настроек

Каждая карточка содержит:

1. название проекта, filename, size, duration и source status;
2. собственный native player, `Настроить нарезки` и `Убрать`;
3. PrimeVue Dialog с отдельным player и SegmentDraft rows по правилам
   `HH:MM:SS.mmm`, exact
   integer milliseconds, `start < end`, `end <= duration`; пересечения можно,
   одинаковые пары нельзя;
4. «Добавить отрезок»;
5. действие только этого source: `Запустить нарезку (N)`;
6. созданные job cards на основной source card вне Dialog: queue/processing
   progress, safe failure, clone failed bounds и `Скачать MP4` при READY.

Кнопки «Запустить всё» здесь нет. Каждый source создаёт отдельный `POST cuts`
со своим idempotency key; ошибки и статусы изолированы. Можно запустить A,
работать с B и потом запустить B. Повтор неясного сетевого результата использует
тот же key и нормализованное body.

Marker buttons пишут `video.currentTime` только из player открытого Dialog в
active segment выбранного source. Dialog и player переключаются вместе, live
message сообщает: «В плеере открыт файл
stream-02.mp4. Начало отрезка 2: 00:12:04.250». Это исключает тихую запись
времени в чужой файл.

### Статусы job

Stage 1 semantics сохраняются. Процент нарезки показывается только из доказуемых
`processedMs / totalMs`: «Обработано 00:42.000 из 01:27.250 (48%).» При
отсутствии точных данных — indeterminate progressbar: «Обработка началась.
Точный прогресс пока недоступен.» Очередь показывает safe queue reason;
terminal states останавливают polling; более низкий `revision` не заменяет
свежий ответ.

## Implemented API semantics

Спецификация не меняет контракт сама. Ниже — обязательная для реализации
семантика, которую API owner добавляет в OpenAPI. Frontend использует generated
client через один typed adapter, не raw HTTP.

| Операция                                     | Требуемая семантика                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/projects?cursor&limit&status&q` | Additive read projection. Stable opaque cursor по `(createdAt,id)`, server-validated limit/status/query. Item: project `id/name/status`, safe source summary (`id`, filename, size, duration/probe state, addedAt) и cut-job counts. Нет storage credentials/keys. |
| `GET project by id`                          | Существующий Stage 1 detail для player, duration и source availability.                                                                                                                                                                                            |
| source playback                              | Существующий safe browser-playable Range endpoint без presigned URL в DTO.                                                                                                                                                                                         |
| upload project/source                        | Существующий per-file idempotent upload. UI отправляет строго последовательно; batch API не требуется. XHR exposes bytes/total только пока браузер их измеряет.                                                                                                    |
| `POST cuts`                                  | Существующий per-project `projectId + segments`. Нет batch endpoint и нет atomic run-all across projects; каждая source row хранит свой idempotency identity.                                                                                                      |
| `GET projects/:id/pipeline-jobs?limit`       | Возвращает до 100 persisted `CUT_SEGMENT` jobs только current source version, newest first; authorization проверяется server-side. Используется для восстановления progress/READY/download после reload.                                                           |
| job/status/download                          | Адресные DTO сохраняют progress/revision/failure/download semantics и polling отдельного активного job.                                                                                                                                                            |

`cursor` frontend не конструирует и не меняет; URL хранит лишь фильтры и поиск,
next opaque cursor — Vue Query pagination state. Новые uploads появляются через
query invalidation, не через несогласованное ручное добавление server model.

## FSD и состояние

```text
pages/library.vue, pages/horizontal.vue          route composition/query validation
widgets/app-shell/                               persistent navigation/sidebar
widgets/media-library/                           toolbar, upload queue, list composition
widgets/horizontal-workspace/                    source card grid + settings Dialog
features/upload-video-queue/                     per-file queue/idempotency/progress
features/select-library-sources/                 multiple selection and navigation
features/edit-cut-segments/                      Stage 1 rules, source scoped
features/submit-video-cuts/                      one-source mutation/idempotency
entities/project/                                list/detail presentation mapping
entities/video-source/                           availability/duration/status helpers
entities/pipeline-job/                           polling/revision/progress/job cards
shared/api/                                      generated client and typed adapters
shared/ui/                                       navigation and accessible controls
```

Dependency direction is `pages -> widgets -> features -> entities -> shared`.
Vue Query owns list/details/persisted jobs; PostgreSQL восстанавливает job
history после reload. Component state owns active player, temporary selection и
unsent per-source drafts. URL owns project selection and library filters. Pinia
is not introduced for server state.

## Accessibility and keyboard behaviour

- Sidebar uses landmark navigation and `aria-current="page"`; disabled vertical
  item is not a deceptive link and has Stage 3 text.
- Lists use headings and labelled checkboxes: «Выбрать stream-01.mp4»; bulk
  selection summary announces once, not on each re-render.
- Player uses native controls and its filename as accessible name; the app never
  globally intercepts Space.
- Time inputs have labels, `aria-invalid` and linked errors. Player switches and
  marker results share one polite live region. Polling ticks are not announced;
  terminal transition is announced once.
- Determinate upload/cut progressbar has min/max/now plus bytes/time text;
  indeterminate phase says percent is unavailable.
- Focus goes to new segment start field after add, nearest row heading/add after
  removal, and workspace heading after returning from source selection.
- Status/error meaning never depends only on colour; honor reduced motion and
  retain visible focus indicators.

## Acceptance criteria

### UI/component

1. Desktop sidebar appears on library/horizontal; `Вертикальные видео` is
   visibly and programmatically unavailable with Stage 3 explanation.
2. Library lists 5+ sources with search, status filtering, cursor pagination,
   loading/empty/error/no-result states and no manual UUID input.
3. User selects up to 20 ready sources, opens stable `/horizontal?projectIds=…`,
   reloads it without browser storage, and invalid IDs do not block valid rows.
4. Upload queue accepts 5+ files, performs one active upload, shows genuine byte
   percent while measurable, distinct finalization, and isolated row failure.
5. Workspace renders five independent source cards as a desktop grid; each
   settings Dialog has the correct player before marker write.
6. Each Dialog supports multiple validated timecode pairs and its own submit;
   no run-all button or cross-source atomicity is implied.
7. Job cards retain Stage 1 queue/processing/ready/failed/download semantics;
   cut percent is real, not invented.
8. Keyboard-only flow supports navigation, selection, timestamps, marker,
   submit and download with labelled controls and meaningful focus recovery.

### Browser smoke

1. Open empty `/library`, upload five small authorized MP4s, observe exactly one
   active XHR upload at a time and real percent while bytes are sent.
2. Select two ready sources, open horizontal workspace, copy/reload its URL,
   and verify both cards and their players return.
3. Create two pairs for A and one for B. Start A, edit B, start B; verify
   separate jobs and independent downloadable MP4s.
4. A pending/failed/`NOT_REVIEWED` source is visibly nonselectable; direct URLs
   do not load its player or editor until the exact source version is cleared.
5. Repeat selection/timecode/submit using keyboard in the supported desktop
   layout.

## Deferred decisions

- Source authorization follows ADR-003. Only the explicit loopback local profile
  may auto-authorize server-side under ADR-004; manual/production never does.
- Project/artifact deletion, sorting and tags need durable API semantics before
  destructive or misleading controls appear.
- Vertical source selection may reuse this projection only when Stage 3 defines
  eligibility and its processing contract.
- Mobile navigation and mobile-specific layout are deferred by the owner until
  after the desktop MVP.
- Timeline, thumbnails and batch orchestration require a later product/API
  decision; they are not inferred from this management UI.
