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

На мобильном экране sidebar становится кнопкой «Разделы» и drawer; текущий
раздел и disabled-статус остаются понятны текстом, не только иконкой или цветом.

## Медиатека

### Список и выбор

Медиатека показывает постраничный список: имя проекта, MP4, размер, дату,
длительность после probe, безопасный status и счётчики созданных/готовых/ошибочных
cut jobs. Поиск работает по проекту и имени файла. Фильтры принадлежат URL,
например `/library?q=stream&status=SOURCE_READY`.

В строке есть checkbox «Выбрать видео». Можно выбрать 5+ файлов, максимум 20:
это ограничение совпадает с deep-link и защищает интерфейс от неуправляемого
экрана. Не `SOURCE_READY` источник виден, но не выбирается: checkbox disabled
и причина показана рядом. До перехода выбор — временное состояние страницы;
после перехода источником истины становится `projectIds` в URL.

Панель действий после выбора: «Выбрано: N» и «Открыть в горизонтальных видео».
Она ведёт на `/horizontal?projectIds={id1,id2,...}` в порядке выбора. Ссылку
можно копировать, открывать и обновлять: данные восстанавливаются по query и
API, не из localStorage.

### Очередь загрузки

Действие «Загрузить видео» открывает inline panel: имя проекта, MP4 и
подтверждение прав **для каждого** файла до отдельного source-authorization
slice. «Добавить ещё файл» создаёт очередь строк. Оператор выбирает один или
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

Всегда есть один `activeProjectId`. Первый доступный source активируется
автоматически; «Открыть в плеере» другой строки переключает только player и
marker buttons. Таймкоды/jobs принадлежат строке и не теряются при переключении.

### Desktop wireframe (>= 1024 px)

```text
┌──── Content Factory ────────────────┬──────────────────────────────────────────────┐
│ [▣] Горизонтальные видео            │ Горизонтальные видео    [Добавить видео]     │
│ [▤] Медиатека                       │ Выбрано: 5 источников                       │
│ [▯] Вертикальные видео               ├──────────────────────────────────────────────┤
│     Появится на Этапе 3              │ ┌─ Sticky active player ───────────────────┐ │
│                                      │ │ stream-01.mp4 · 02:00:00.000             │ │
│                                      │ │              [ native video ]             │ │
│                                      │ │ Позиция 00:12:04.250                     │ │
│                                      │ │ [Установить начало] [Установить конец]    │ │
│                                      │ └───────────────────────────────────────────┘ │
│                                      ├──────────────────────────────────────────────┤
│                                      │ stream-01.mp4 [В плеере] [Убрать]           │
│                                      │ 1 Начало [00:12:04.250] Конец [00:13:31.500] │
│                                      │ [+ Отрезок] [Запустить нарезку (1)]         │
│                                      │ Готово · [Скачать MP4]                      │
│                                      ├──────────────────────────────────────────────┤
│                                      │ stream-02.mp4 [Открыть в плеере] [Убрать]   │
│                                      │ 1 Начало […] Конец […]  [+ Отрезок]         │
│                                      │ [Запустить нарезку (2)] · В очереди          │
│                                      └──────────────────────────────────────────────┘
└──────────────────────────────────────┴──────────────────────────────────────────────┘
```

Sidebar занимает 224–272 px, контент имеет ограниченную читаемую ширину. Player
закреплён в верху scroll container, но при недостаточной высоте перестаёт быть
sticky, а не перекрывает поля или native controls.

### Mobile wireframe (320–1023 px)

```text
┌──────────────────────────────────┐
│ [Разделы] Горизонтальные видео    │
│ [Добавить видео]                  │
├──────────────────────────────────┤
│ stream-01.mp4 · В плеере          │
│        [ native video ]           │
│ [Начало] [Конец]                  │
├──────────────────────────────────┤
│ stream-01.mp4 [В плеере] [Убрать] │
│ Начало [00:12:04.250]             │
│ Конец   [00:13:31.500]            │
│ [+ Отрезок] [Запустить (1)]       │
├──────────────────────────────────┤
│ stream-02.mp4 [Открыть в плеере]  │
│ …                                 │
└──────────────────────────────────┘
```

Контент — одна колонка: player, затем source rows. Player не sticky. Поля и
действия переносятся без горизонтальной прокрутки; touch targets от 44×44 px.

### Строка источника

Каждая source row содержит:

1. название проекта, filename, size, duration и source status;
2. `Открыть в плеере` / `В плеере` и `Убрать из рабочего места`;
3. локальные SegmentDraft rows с Stage 1 правилами: `HH:MM:SS.mmm`, exact
   integer milliseconds, `start < end`, `end <= duration`; пересечения можно,
   одинаковые пары нельзя;
4. «Добавить отрезок»;
5. действие только этого source: `Запустить нарезку (N)`;
6. созданные job cards: queue/processing progress, safe failure, clone failed
   bounds и `Скачать MP4` при READY.

Кнопки «Запустить всё» здесь нет. Каждый source создаёт отдельный `POST cuts`
со своим idempotency key; ошибки и статусы изолированы. Можно запустить A,
работать с B и потом запустить B. Повтор неясного сетевого результата использует
тот же key и нормализованное body.

Marker buttons пишут `video.currentTime` только в active segment active source.
Если фокус переходит в segment другого source, он становится active, player
переключается до записи, live message сообщает: «В плеере открыт файл
stream-02.mp4. Начало отрезка 2: 00:12:04.250». Это исключает тихую запись
времени в чужой файл.

### Статусы job

Stage 1 semantics сохраняются. Процент нарезки показывается только из доказуемых
`processedMs / totalMs`: «Обработано 00:42.000 из 01:27.250 (48%).» При
отсутствии точных данных — indeterminate progressbar: «Обработка началась.
Точный прогресс пока недоступен.» Очередь показывает safe queue reason;
terminal states останавливают polling; более низкий `revision` не заменяет
свежий ответ.

## Proposed API semantics (pending implementation)

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
| job/status/download                          | Существующие Stage 1 адресные DTO, progress/revision/failure/download semantics.                                                                                                                                                                                   |

`cursor` frontend не конструирует и не меняет; URL хранит лишь фильтры и поиск,
next opaque cursor — Vue Query pagination state. Новые uploads появляются через
query invalidation, не через несогласованное ручное добавление server model.

## FSD и состояние

```text
pages/library.vue, pages/horizontal.vue          route composition/query validation
widgets/app-shell/                               persistent navigation/sidebar
widgets/media-library/                           toolbar, upload queue, list composition
widgets/horizontal-workspace/                    sticky player + source rows composition
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
Vue Query owns list/details/jobs; component state owns active player, temporary
selection and unsent per-source drafts. URL owns project selection and library
filters. Pinia is not introduced for server state.

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
5. Workspace has independent source rows and one sticky active player desktop;
   selecting a segment makes the correct source active before marker write.
6. Each row supports multiple validated timecode pairs and its own submit;
   no run-all button or cross-source atomicity is implied.
7. Job cards retain Stage 1 queue/processing/ready/failed/download semantics;
   cut percent is real, not invented.
8. Keyboard-only flow supports navigation, selection, timestamps, marker,
   submit and download with labelled controls and meaningful focus recovery.

### Browser smoke

1. Open empty `/library`, upload five small authorized MP4s, observe exactly one
   active XHR upload at a time and real percent while bytes are sent.
2. Select two ready sources, open horizontal workspace, copy/reload its URL,
   and verify both rows and the first active player return.
3. Create two pairs for A and one for B. Start A, edit B, start B; verify
   separate jobs and independent downloadable MP4s.
4. A pending/failed source is visibly nonselectable; a URL with one bad and one
   ready ID still permits the ready source to be used.
5. Repeat selection/timecode/submit by keyboard at 320 CSS px with no horizontal
   page scroll or inaccessible action.

## Deferred decisions

- Source authorization replaces the per-upload rights checkbox only in its own
  additive slice; this document does not hide or auto-confirm it.
- Project/artifact deletion, sorting and tags need durable API semantics before
  destructive or misleading controls appear.
- Vertical source selection may reuse this projection only when Stage 3 defines
  eligibility and its processing contract.
- Timeline, thumbnails and batch orchestration require a later product/API
  decision; they are not inferred from this management UI.
