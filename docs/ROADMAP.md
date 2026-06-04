# Cuprum Roadmap

> **Трекер задач — GitHub Project «Cuprum Roadmap»:**
> <https://github.com/users/fixcik/projects/2>
>
> Бэклог, статусы и конкретные задачи живут **там** (issues; эпики — через sub-issues;
> колонки `Backlog → Todo → In Progress → In Review → Done`). Этот файл — только
> **высокоуровневые фазы и видение**, не трекер. Брать задачу — `/task #N`.
>
> «Зачем и почему» — [`VISION.md`](VISION.md); модель данных `.cuprum` —
> [`PROJECT.md`](PROJECT.md); термины — [`GLOSSARY.md`](GLOSSARY.md).

## Где мы сейчас

**Готово (крупные вехи):**

- **Движок:** парс Gerber/Excellon, растеризация (tiny-skia), композ на экран
  15120×6230, `.goo`-энкодер, SDCP-клиент (discovery/upload/expose) — **UV-засветка
  работает в железе** (Elegoo Saturn 4 Ultra 16K).
- **Архитектура:** монолит `cuprum-core` расщеплён на **11 крейтов** (core/gerber/dfm/
  mesh/goo/sdcp/grbl/diskcache/cache/trace + project/cli); `gerber-viewer` форкнут до
  ядра парсинга внутрь `cuprum-gerber`.
- **CLI v1:** тулбокс `info`/`render`/`svg`/`3d`/`check` над папкой герберов и `.cuprum`.
- **Документ проекта `.cuprum`:** working-dir, автосейв, undo/redo, restore points,
  персистентные рендер-артефакты; галерея дизайнов + инспектор (2D/3D + DFM).
- **Panel-модель:** интерактивный редактор размещения (выделение/move/rotate/align/
  smart-guides/re-nest/context-menu), ToolingHole'ы, keep-out зоны, панельный
  DFM-вердикт.
- **CNC-старт:** связь со станком по GRBL (`cuprum-grbl`, UI «Станок» — DRO/jog/home/
  zero/шпиндель), CNC-`MachineProfile` + `ToolLibrary`.

**Текущий фокус:** довести Panel-редактор и выйти на сквозную сверловку на ЧПУ.

## Фазы

Детали и статусы — в эпиках на борде (номера issue ниже).

- **Phase 1 — Panel-модель** ([#178](https://github.com/fixcik/cuprum/issues/178)).
  Завершение редактора: отвязка панели от станка, производные мёртвые зоны вокруг
  tooling, мин. зазор от фрезы реза, корректный `compose` Panel→Machine под произвольный
  угол. *Веха:* дизайны корректно кладутся на панель, геометрия раскладки верна.

- **Phase 2 — CNC: сверловка (end-to-end)** ([#179](https://github.com/fixcik/cuprum/issues/179)).
  Самый узкий путь к ЧПУ: связь GRBL ✅ → CNC-профиль + ToolLibrary ✅ → сбор отверстий
  панели → эмиттер G-code → превью → прогон вживую. *Веха:* реальные отверстия в FR4.

- **CNC: изоляция / контур / нивелирование** ([#180](https://github.com/fixcik/cuprum/issues/180), `[later]`).
  Второй медный путь (фрезеровка вместо UV) и раскрой: isolation milling, ProfileRoute
  с tabs, auto-leveling (probing), калибровка станка, `ProcessStep`, реестр станков.

- **Phase 3 — Первая реальная плата** ([#181](https://github.com/fixcik/cuprum/issues/181)).
  Выход из теории: материалы, тестовая плата в KiCad, сквозной прогон pipeline, сборка
  и проверка. *Веха:* одна **работающая** плата в руках.

- **Phase 4–5 — доводки и полировка** (#209–219, `Backlog`).
  UV-flow на новой модели (двусторонка, StepExposureTest/CalibrationLog) и расширения
  (Compensation, Gerber X2, solder mask, test patterns, silkscreen, др. принтеры, PTH).

## Вне скоупа `[не делать пока]`

Не в плане ближайшего года:

- Multilayer (4+ слоя) — дома практически невозможно
- Pattern plating, surface finish (ENIG/HASL/OSP) — промышленные процессы
- DRC / netlist-валидация — это работа KiCad, не Cuprum
- Импорт чего-либо кроме Gerber + Excellon (ODB++, IPC-2581)
- Электрический тест (ICT, flying probe)

---

*Ревизия 2026-06-04. Этот файл — нарратив фаз; конкретные задачи и статусы — на
[борде](https://github.com/users/fixcik/projects/2).*
