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

