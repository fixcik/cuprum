# Changelog

All notable changes to Cuprum are documented here.
This project follows [Conventional Commits](https://www.conventionalcommits.org)
and [Semantic Versioning](https://semver.org).

## [0.3.0] - 2026-06-02

### Features

- **project**: Smart restore-point retention + orphaned-gerber GC (#31)
- Local tracing for profiling heavy pipeline phases (#14)
- **project**: BoardInstance + ToolingHole in PanelDoc (schema v5) (#13)
- **ui**: Designs/home polish + dark number-field spinners (#11)

### Bug Fixes

- **core**: Attribute annular hotspots to the pad's copper side (#32)
- **core**: Global tracing subscriber with per-operation routing (#24)
- Deterministic board_metrics hotspot ordering + guard test (#17)

### Performance

- **core**: Balance sweep chunks and reuse the visited buffer per worker (#29)
- **project**: Ship render artifacts (svg/metrics/preview) inside .cuprum (#26)
- **ui**: Build 3D board mesh lazily on first 3D view (#28)
- **core**: Parse each layer once across board_metrics analyses (#25)
- In-memory LRU + single-flight cache for board metrics (#23)
- **ui**: Batch SVG layer loading + in-memory cache & single-flight in core (#21)
- **core**: Flat grid + parallel per-layer clearance/width sweep (#20)
- **core**: One-sided clearance/width sweep (skip discarded half) (#19)
- **core**: Overlap zone-3 DFM analyses with clearance/width scan via rayon::join (#18)
- Concurrent DFM clearance/width passes + sweep micro-opts (~1.6x metrics) (#16)
- Parallelize DFM clearance/width hotspots + CUPRUM_NO_CACHE + deterministic dedup (#15)

### Refactor

- **core**: Propagate metrics/sweep tracing via capture_dispatch helper (#22)
- **project**: Document module + centralized migrations (#12)

### Documentation

- Roadmap — show all DFM hotspots + clickable finding-type filter popup
- **roadmap**: Add cross-operation gerber parse cache item (#27)

### Testing

- **core**: Add criterion benchmarks for board_metrics on the plaid board (#30)

### CI

- Stop saving rust cache on release (flaky windows post-step failed publish) (#10)

## [0.2.0] - 2026-06-01

### Features

- Open projects by double-click (.cu/.cuprum) + macOS dock integration (#9)
- Collapse import + designs gallery & inspector (#8)
- Autosave + undo/redo + restore points (#7)
- Working-dir foundation for project files (phase 1) (#5)
- Tabbed project page with FR4 panel-blank setup (#4)
- Thin-copper DFM via conductor model + per-cluster DRC navigation (#3)

### Refactor

- Fold panel.json into the manifest (#6)

### Chores

- **ui**: Rename window title to Cuprum CAM

## [0.1.0]

### Features

- **ui**: Localization (en/ru) + unit switching (mm/imperial) (#1)

### Other

- Initial commit

Cuprum — a CAM toolchain for making printed circuit boards at home.

- cuprum-core: Gerber parsing, rasterization, screen composition, .goo
  encoding, and the SDCP printer protocol (discover/upload/expose).
- cuprum-cli: the `cuprum` command-line tool.
- cuprum-project: the self-contained .cuprum project container.
- cuprum-ui: Tauri 2 + React desktop app with 2D preview, CAD-style
  navigation, auto-layout, and a 3D board view.

Dual-licensed under MIT OR Apache-2.0.

### Documentation

- Add board preview screenshot to README

### CI

- CI + manual release pipeline, app version in UI (#2)


