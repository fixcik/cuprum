# Cuprum — дизайн-система и решения

Источник правды для внешнего вида UI. Любой новый экран обязан использовать токены и
компоненты отсюда, а не сырые палитры Tailwind. Появился после рассинхрона: первый
вариант Home был синий с нативным `<select>`, тогда как редактор засветки — тёмный с
медным акцентом и аккуратными контролами. Чтобы такого не повторялось — этот файл.

## Тема

Тёмная техническая тема (вайб VSCode / BambuLab) с **медным (copper) акцентом**.

**Единый источник темы — `cuprum-ui/src/styles.css`** (Tailwind v4 `@theme inline`): HSL-токены
заданы там как CSS-переменные и проброшены в утилиты Tailwind. Меняем цвета только там;
таблица ниже — снимок для справки, а не второй источник. В разметке используем
**семантические классы** (`bg-primary`, `text-muted-foreground`, …), а НЕ сырые
(`bg-blue-600`, `text-neutral-400`).

### Цветовые токены

| Токен (Tailwind) | Назначение | HSL |
|---|---|---|
| `bg-background` / `text-foreground` | фон приложения / основной текст | `222 16% 9%` / `210 20% 92%` |
| `bg-card` | плавающие карточки/поповеры | `222 15% 12%` |
| `bg-panel` | боковые панели (инспектор, рейл-контейнеры) | `222 14% 13%` |
| `bg-muted` / `text-muted-foreground` | приглушённый фон / вторичный текст | `222 12% 18%` / `215 14% 60%` |
| `border-border` | разделители, рамки | `222 12% 20%` |
| `border-input` | рамки полей ввода | `222 12% 22%` |
| `ring-ring` | фокус-кольцо | = primary |
| `bg-primary` / `text-primary-foreground` | **медный акцент**: первичные кнопки, активные состояния | `24 80% 52%` / `24 30% 10%` |
| `bg-destructive` / `text-destructive-foreground` | опасные действия (Stop, удалить) | `0 70% 50%` / белый |
| `bg-pcb-preview` | плейсхолдер превью платы на Home (до 3D/preview) | `158 45% 14%` |
| `--radius` | базовый радиус (`rounded-lg`=0.5rem, `md`, `sm`) | `0.5rem` |

**Правило акцента:** всё «активное/первичное» — медное. Никакого синего. Первичная
кнопка — `bg-primary text-primary-foreground`. Активный сегмент/иконка-таб —
`bg-primary/20 text-primary` (см. рейл и тулбар). Фокус — `focus:ring-1 focus:ring-ring`.

## Типографика

- База: `13px`, `ui-sans-serif/system-ui` (см. `styles.css`).
- Заголовок секции: `text-[11px] font-semibold uppercase tracking-wide text-muted-foreground`.
- Числовые значения: `tabular-nums` (чтобы не «прыгали»).
- Вторичный текст/подписи: `text-muted-foreground`, размеры `text-[11px]/[12px]`.

## Поверхности и слои

- Корень приложения — `bg-background`.
- Боковые панели и контейнеры навигации — `bg-panel`, разделены `border-border`.
- Плавающие элементы над холстом (палитра инструментов) — `bg-card/90` + `shadow-lg` + `backdrop-blur`.
- Секции внутри панели — разделитель `border-b border-border`, паддинг `px-3 py-3`.

## Компоненты (реюзабельные)

Все интерактивные контролы — из `components/ui/`. **Не верстаем нативные `<select>`
и «голые» `<input>` по месту** — берём примитив.

### Существующие (`components/ui/`)
- **`Button`** (`Button.tsx`) — cva-варианты: `default` (медная), `secondary` (muted),
  `ghost`, `destructive`, `outline`; размеры `default`/`sm`/`icon`. Иконка lucide слева через `gap-2`.
- **`Slider`** (`Slider.tsx`) — radix; трек `bg-muted`, заполнение/палец `bg-primary`.
- **`Switch`** (`Switch.tsx`) — radix; вкл — `bg-primary`, выкл — `bg-muted`.
- **`HelpTip`** (`HelpTip.tsx`) — иконка-«?» (lucide `HelpCircle`) с поповер-подсказкой на
  radix-tooltip. Контент — `bg-popover`, опц. SVG-иллюстрация сверху. Ховер/курсор — только
  на самой иконке (`cursor-help`, `hover:bg-foreground/10`), не на строке. Ставим у полей
  настроек/форм, чтобы пояснить параметр.

### Примитивы форм (заведены в этой итерации)
- **`TextInput`** — текстовое поле/поиск. База поля:
  `h-8 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:ring-1 focus:ring-ring`.
  Вариант с иконкой-префиксом (например, лупа поиска) — иконка `absolute`, паддинг слева.
- **`Select`** — стилизованный селект (НЕ нативный вид): тот же бордюр/фон, что у полей,
  `h-8 rounded-md border border-input bg-background px-2 pr-7 text-[12px]`, своя стрелка
  (lucide `ChevronDown`, `absolute`, `pointer-events-none`), скрываем нативную стрелку
  (`appearance-none`). Опции — `bg-popover`.
- **`SegmentedControl`** — переключатель из 2–N иконок/лейблов (сетка/список и т.п.):
  контейнер `rounded-md border border-input overflow-hidden`, активный сегмент
  `bg-primary/20 text-primary`, неактивный `text-muted-foreground hover:text-foreground`.

### Планируется
- **`NumberInput`** — числовое поле; вынести из `Inspector.NumberField`
  (`h-7 w-20 rounded-md border border-input bg-background px-2 text-right tabular-nums`,
  опц. `label`/`suffix`) при подключении редактора засветки, заодно отрефакторив Inspector.

### Иконки
- Только **lucide-react** (плоские SVG). Без эмодзи. Размер обычно `size-4` (16) в кнопках,
  20 в рейле навигации.
- Кнопка-иконка / таб: активная — `bg-primary/20 text-primary`, иначе
  `text-muted-foreground hover:text-foreground`, `disabled:opacity-30`.

### Курсоры
Курсор должен соответствовать семантике элемента — задаём явно, не полагаемся на дефолт.
- **Интерактивное (кнопки, табы, ссылки, кликабельные строки)** — `cursor-pointer`. Глобально
  уже включено для `button:not(:disabled)` в `styles.css`; для не-`button` кликабельного
  ставим класс явно.
- **Подсказка/справка** (иконка-«?», `HelpTip`, элемент с тултипом-пояснением) — `cursor-help`.
- **Заблокированное** — `cursor-not-allowed` + `opacity` (radix-контролы делают это сами через
  `disabled:`).
- **Перетаскивание** (раскладка плат, ручки) — `cursor-grab` / `cursor-grabbing`.
- **Ввод текста** — дефолтный `text` (не трогаем).
Ховер-эффект (цвет/подложка) вешаем на сам элемент, а не на строку-контейнер — чтобы реакция
была привязана к иконке/контролу, а не ко всей строке.

## Структура файлов фронтенда

Проект растёт — держим дерево чистым. **Один компонент = один файл.** Выделяем
переиспользуемые примитивы.

```
cuprum-ui/src/
  pages/                 # точки входа уровня экрана (рендерятся из App по view)
    HomePage.tsx
    ProjectPage.tsx
    PrinterPage.tsx
    SettingsPage.tsx
  components/
    ui/                  # реюзабельные примитивы (Button, Slider, Switch,
                         #   TextInput, NumberInput, Select, SegmentedControl)
    nav/                 # навигация (NavRail)
    home/                # части Home (RecentTile, …)
    editor/              # редактор засветки (PreviewCanvas, Inspector,
                         #   CanvasToolbar, StatusBar) — пока не смонтирован
  lib/                   # api.ts, utils.ts (cn)
  shellStore.ts          # стор оболочки (навигация + недавние + текущий проект)
  store.ts               # стор редактора засветки
  App.tsx, main.tsx, styles.css
```

Правила:
- **`pages/`** — композиция экрана из компонентов; точка входа на каждый `view` оболочки.
- **`components/<группа>/`** — группируем по смыслу (`ui`, `nav`, `home`, `editor`).
- Переиспользуемое (поля, селекты, кнопки) живёт только в `components/ui/`.
- Все импорты — через алиас `@/` (не относительные), чтобы перенос файлов не ломал ссылки.
- (На будущее) сторы можно собрать в `src/stores/`; пока два стора лежат в корне `src/`.

## Журнал решений

- **2026-05-29 — медный акцент, семантические токены.** Акцент `--primary` = медь (`24 80% 52%`).
  В разметке только семантические классы; сырые палитры (`bg-blue-*`, `text-neutral-*`) запрещены —
  иначе экраны расходятся по стилю (как разъехались Home и редактор засветки в первой версии).
- **2026-05-29 — radix + cva примитивы.** Интерактивные контролы строим на radix (Switch/Slider)
  и cva-вариантах (Button); нативные `<select>` не используем — заводим `Select` с общим стилем поля.
- **2026-05-29 — иконки lucide-react, без эмодзи.**
- **2026-05-29 — структура `pages/` + сгруппированные `components/`,** один компонент на файл.
- **2026-05-30 — курсоры по семантике (см. «Курсоры»).** `pointer` для интерактива, `help` для
  подсказок (`HelpTip`/«?»), `not-allowed` для заблокированного, `grab`/`grabbing` для
  перетаскивания. Ховер вешаем на сам элемент, не на строку. Заведено, чтобы не повторять
  правило вручную для каждого нового контрола.
- **2026-05-30 — `HelpTip` + схематичные SVG-диаграммы (`components/settings/diagrams.tsx`)**
  для пояснения параметров (медь=золото, маска=зелёный, FR4=олива, размерные линии
  `currentColor`). Настройки — левое таб-меню (`SettingsPage`), расширяемое новыми группами.
