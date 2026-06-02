# Cuprum Roadmap

Дорожная карта ближайших шагов. Текущий статус и план до первой реальной
платы. Видение и обоснование выбора — [`VISION.md`](VISION.md); модель
данных — [`PROJECT.md`](PROJECT.md); канонические термины —
[`GLOSSARY.md`](GLOSSARY.md).

## Где мы сейчас

**Готово:**

- Парс Gerber, растеризация (tiny-skia), композ на экран 15120×6230
- `.goo` энкодер, SDCP клиент (discovery / upload / expose)
- UV-засветка работает в железе (Elegoo Saturn 4 Ultra 16K)
- Tauri UI с превью, multiselect + marquee, align/distribute, persist
- CLI: `discover`, `gerber-info`, `render`, `prepare`, `upload`, `expose`
- Стартовый экран + каталог недавних (SQLite MRU), контейнер `.cuprum` (ZIP)
- Документ проекта: working-dir (распаковка в temp, loose-чтение, recovery/GC),
  автосейв, undo/redo, restore points; `panel` свёрнут в манифест (схема v4)

**Чего нет:**

- Panel-модели в UI: структуры данных (`BoardInstance`/`ToolingHole`, `PanelDoc`
  v2) заведены, но **редактора размещения и Panel-превью ещё нет** (дизайны пока
  не кладутся на панель)
- CNC вообще: ни G-code, ни ToolLibrary, ни auto-leveling
- Ни одной реальной платы в руках

## Workstream: модель проекта `.cuprum` + UX дизайнов

Инфраструктура документа проекта и UX управления дизайнами — фундамент под
Panel-модель ниже. Ведётся инкрементальными PR по принятому рабочему процессу.

- [x] **Фаза 1 — working-dir** (✅ 2026-05-31, PR #5): открытие распаковывает `.cuprum` в temp,
      чтение/рендер по loose-файлам, recovery + GC осиротевших папок.
- [x] **(рефактор) panel → manifest** (✅ 2026-05-31, PR #6): `panel.json` свёрнут в манифест
      (схема v4 + миграция легаси) — документ стал одним файлом.
- [x] **Фаза 2 — автосейв + undo/redo + restore points** (✅ 2026-06-01, PR #7): снимки манифеста
      для undo/redo, контрольные точки в `history/` (ручная кнопка 💾 + авто на
      открытии с дедупом), тулбар ◀/▶/💾 + хоткеи; импорт отменяем.
- [x] **Фаза 3 — схлопывание импорта** (✅ 2026-06-01, [PR #8](https://github.com/fixcik/cuprum/pull/8)):
      `addDesignFromZip` (копирование в working-dir + авто-классификация),
      удаление staging-команд и визарда; относительное время в restore points.
- [x] **Фаза 4 — галерея дизайнов + инспектор** (✅ 2026-06-01, [PR #8](https://github.com/fixcik/cuprum/pull/8)): карточки по
      дизайну (превью-thumbnail + DFM-вердикт), drag'n'drop ZIP в каталог,
      удаление дизайна, переиспользуемый инспектор (2D/3D + редактируемые типы
      слоёв + DFM через `projectBoardMetrics`); удаление `ImportWizardPage`/`DesignsTab`.
      DFM-проверка размера дизайна — против панели проекта (фолбэк на макс. станка),
      размер панели клампится по рабочей зоне из настроек.
- [x] **Фаза 5 — открытие по клику** (✅ 2026-06-01, [PR #9](https://github.com/fixcik/cuprum/pull/9)):
      ассоциация `.cu`/`.cuprum` (дефолт `.cu`); `RunEvent::Opened` + single-instance + argv →
      `take_pending_open`/событие `open-file` в `App.tsx`; идемпотентный `openProjectByPath`;
      dock-recents на macOS (`NSDocumentController.noteNewRecentDocumentURL`).

Бэклог:
- **Рендер-артефакты как часть проекта** (SVG-слои + `preview.png`). SVG-кеш слоёв
  переезжает из глобального app-cache в `<workdir>/artifacts/` (persistent, едет с
  `.cuprum` через `workdir::pack`) → переданный проект не пересчитывается. Плюс
  backend-композит превью дизайна (`resvg`) в `artifacts/preview/<id>.png`: карточка
  показывает один `<img>` вместо тяжёлого SVG-DOM (фикс торможения фронта на «куче
  дизайнов»). 2 PR: (1) SVG-слои project-scoped + persistent diskcache; (2) backend
  preview + карточка на `<img>`. Опирается на batch-SVG ([PR #21](https://github.com/fixcik/cuprum/pull/21)).
- **Удаление дизайна ↔ панель.** Сейчас удаление снимает только ссылку из
  манифеста (байты герберов остаются — undo/restore валидны). Когда появится
  размещение дизайнов на панели (`BoardInstance`), удаление дизайна должно
  снимать и его размещения с панели (и наоборот — нельзя удалить дизайн,
  «молча» оставив висящий placement).
- **Кастомное меню приложения (menu bar).** Своё нативное меню в строке меню
  (macOS) / меню окна (Win/Linux) вместо дефолтного Tauri — **развиваем
  постепенно**. Пункты связываем с действиями `shellStore`: File (Новый проект,
  Открыть, Открыть недавние, Сохранить-точку), Edit (Undo/Redo), View и т.д.
  Tauri 2 `Menu`/`MenuItem` API. Стыкуется с open-by-click и dock-recents
  (Фаза 5) — единая «оболочка» приложения вокруг проекта.
- **Кросс-операционный парс-кеш герберов.** На холодном первом показе дизайна
  три независимые операции (`board_mesh` / `board_metrics` / SVG-batch)
  парсят одни и те же гербер-байты — конкурентно, т.е. большой медный слой
  разбирается ~3× одновременно (лишний CPU + контеншн за ядра). Каждая операция
  уже кеширует свой *результат*, поэтому проблема только холодная. Идея: общий
  кеш `GerberLayer` по `hash(bytes)`, который переиспользуют все три (parse-once
  внутри `board_metrics` уже сделан — это его межоперационное продолжение).

## Phase 1 — Panel-модель `[in progress]`

**Цель:** перевести модель данных с `placements[]` на схему из
[`PROJECT.md`](PROJECT.md), чтобы остальное строилось на ней, а не на
обходных путях.

- [x] Schema migration: `placements[]` → `Panel + BoardInstance[] + ToolingHole[]` (✅ 2026-06-01, [PR #12](https://github.com/fixcik/cuprum/pull/12) рефактор `document/` + централизованные миграции, [PR #13](https://github.com/fixcik/cuprum/pull/13) структуры + схема v5)
- [x] Переименование `manifest.imports[]` → `manifest.designs[]` (✅ 2026-05-31, PR #4)
- [x] `Stackup` в манифесте: `copper_weight_oz`, `substrate_thickness_mm`, `double_sided` (+ `panel` в манифесте, схема v4) (✅ 2026-05-31, PR #4)
- [ ] Panel editor UI: холст в Panel space, drag BoardInstance, инструмент «ToolingHole»
      (сейчас есть только редактор FR4-бланка: размер + stackup)
- [ ] `compose` рефактор: Panel space → Machine space (UV-пиксели); произвольный
      поворот инстанса требует анизотропно-корректного ре-рендера в
      `compose::compose_layout` (там TODO — пиксели 14×19 мкм)
- [x] Backward compat: открытие старых `.cuprum` мигрирует автоматически (✅ 2026-06-01,
      [PR #12](https://github.com/fixcik/cuprum/pull/12) — централизованный Value-пайплайн
      `migrate`, [PR #13](https://github.com/fixcik/cuprum/pull/13) — шаг v4→v5)

**Milestone:** старый проект открывается, виден Panel вместо LCD,
добавляются ToolingHole'ы, засветка работает как раньше.

## Phase 2 — CNC workflow `[next]`

**Цель:** первый практический путь до платы без химии — isolation milling
на CNC 3018. Это самый быстрый способ дойти до реального результата и
откалибровать сам станок.

- [ ] `MachineProfile` для CNC: расширение `capabilityProfile` до варианта
      `Cnc { spindle, runout, backlash, probe, gcode_dialect, ... }`.
      Дефолт под CNC 3018 Lunyee.
- [ ] `ToolLibrary` в settings: `Drill / EndMill / VBit` с диаметром,
      углом (для VBit), `max_rpm`, рекомендованными feeds для FR4
- [ ] **G-code emitter** для GRBL 1.1:
      - G0/G1, M3/M5, S для шпинделя
      - G38.2 для probe
      - M6 как manual pause для смены инструмента
- [ ] **Isolation milling**: `isolation_paths(layer, tool, depth)` в
      `geometry.rs` — offset polygon на ширину реза V-bit; multi-pass для
      voronoi clearing
- [ ] **ProfileRoute** с авто-Tab'ами по периметру + drag для коррекции
- [ ] **Auto-leveling**:
      - probing UI (зажим-крокодил к меди + щуп)
      - G38.2 grid по сетке N×N
      - построение HeightMap
      - warp-компенсация Z на этапе эмиссии G-code
- [ ] **Редактор ProcessStep'ов**: массив, drag для переупорядочки, кнопки
      «Сгенерировать G-code» и «Сбросить к шаблону»

**Milestone:** сгенерил `.nc`, прогнал по воздуху в Candle/UGS, движения
адекватные.

## Phase 3 — Первая реальная плата

**Цель:** выход из теории. Без этого следующие фазы — пальцем в небо.

- [ ] Купить материалы:
      - односторонний FR4 100×100 мм (1.6 мм)
      - V-bit 30° (1–2 штуки)
      - карбидные свёрла 0.6 / 0.8 / 1.0 мм
      - endmill 1 мм PCB-router (chipbreaker)
      - spoil board MDF
      - зажим-крокодил для probe
- [ ] Допилить probe UI (после прогона на железе всплывут косяки)
- [ ] Развести в KiCad простую плату — LED-мигалка на NE555 или
      что-то аналогичное с DIP-компонентами
- [ ] Прогнать весь pipeline: импорт → Panel → ToolingHole → ProcessStep'ы
      → milling → drill → ProfileRoute
- [ ] Собрать → проверить мультиметром → запаять компоненты → завестись

**Milestone:** одна **работающая** плата в руках. Из неё — список багов и
приоритетов на Phase 4.

## Phase 4 — Доделать UV-flow на новой модели

**Цель:** доказать параллельный путь — UV-засветка тоньше и быстрее
milling'а на сложных платах.

- [ ] `compose` рефактор: читает Panel + BoardInstance + LayerRef,
      mirror по Y для `Bottom`
- [ ] **StepExposureTest** — мульти-слойный `.goo` для калибровки дозы
- [ ] **CalibrationLog** базовый: запись результата + история, разворот
      под текущим временем засветки в `MachineProfile`
- [ ] Двусторонка на ToolingHole: засветка top → переворот → засветка bottom

**Milestone:** первая двусторонка через UV-засветку.

## Phase 5 — Полировка (в порядке убывания пользы)

- [ ] **Compensation** (default per GerberLayer) + UI-слайдер с live preview
- [ ] **Gerber X2** парсинг (`AperFunction`), fallback на эвристику
- [ ] **Solder mask** workflow (отдельная плёнка, засветка, проявка)
- [ ] Дополнительные TestPattern'ы: `TraceWidthTest`, `ClearanceTest`,
      `AnisotropyTest`, `MaskDoseTest`
- [ ] Silkscreen
- [ ] Поддержка других UV-LCD принтеров (новые `MachineProfile`)
- [ ] **Меднение / PTH** — графитовая активация + CuSO4 электролиз, если
      реально пойдёшь

## Backlog `[не делать пока]`

Сюда то, что **не** в плане ближайшего года:

- Multilayer (4+ слоя) — дома практически невозможно
- Pattern plating (требует tin-ванну и второй цикл резиста)
- Surface finish (ENIG / HASL / OSP) — промышленный процесс
- DRC / netlist-валидация — это работа KiCad, не Cuprum
- Импорт чего-либо кроме Gerber + Excellon (ODB++, IPC-2581)
- Электрический тест (ICT, flying probe)

## Открытые вопросы по приоритетам

1. **VISION.md под новый порядок.** Сейчас он говорит «UV первичен»,
   milling вообще не упомянут. Надо обновить, чтобы документация не
   рассинхронилась.
2. **Phase 3 — какая плата?** LED-мигалка на NE555 или сразу что-то
   утилитарное под себя (например, breakout-плата под датчик)?
3. **Phase 2 — auto-leveling: интегрировать в Cuprum или сначала
   использовать сторонний инструмент** (bCNC AutoLevel, AutoLeveller AE)
   и вшить в Cuprum только после первой платы?

---

*Ревизия 2026-06-02. Обновлять при сдвиге фаз и появлении новых
приоритетов.*
