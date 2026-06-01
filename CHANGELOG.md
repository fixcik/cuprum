# Changelog

All notable changes to Cuprum are documented here.
This project follows [Conventional Commits](https://www.conventionalcommits.org)
and [Semantic Versioning](https://semver.org).

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


