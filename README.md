# Cuprum

**A CAM toolchain for making printed circuit boards at home — one tool for the
whole cycle, from fab package to finished board.**

![Cuprum — import wizard with live board preview](docs/preview.png)

Cuprum takes a Gerber/Excellon fab job and drives the machines on your bench to
produce a real PCB. It treats fabrication as a set of *processes* — each one a
(layer, machine, action) — and ties them together with shared fiducials so the
steps register against each other automatically.

The first process to land is **UV photolithography**: exposing the copper
artwork through a high-resolution UV LCD (Cuprum currently drives an
[Elegoo Saturn 4 Ultra 16K](https://www.elegoo.com/)). Drilling and edge-cut
routing on a CNC are next on the roadmap.

> Status: early, actively developed. The UV exposure pipeline works end-to-end;
> the rest of the CAM features (drill, edge-cut routing, fiducial registration)
> are on the roadmap. See [`docs/VISION.md`](docs/VISION.md).

## Approach

Cuprum plays to each tool's strengths rather than forcing one machine to do
everything:

- **Light for copper.** Exposing traces and pads is *parallel* — the entire
  artwork lands in a single flash (~90 s) regardless of trace density or how
  many boards are on the bed. A modern UV LCD also resolves a fine pitch
  (a 16K screen is ≈14×19 µm per pixel), finer than a cheap CNC mill can route.
- **CNC for the rest.** Use a mill only where light can't help: drilling holes
  and cutting the board outline.
- **Fiducials tie it together.** One set of registration marks links every
  process, so exposure → drilling and double-sided alignment become automatic.

## What's here

| Component        | Crate / dir            | What it does |
|------------------|------------------------|--------------|
| **Core library** | `crates/cuprum-core`   | Gerber parsing, rasterization (tiny-skia), composition onto the 15120×6230 screen, `.goo` encoding, and the SDCP protocol (discover / upload / expose). |
| **CLI**          | `crates/cuprum-cli`    | `cuprum` binary: `discover`, `gerber-info`, `render`, `prepare`, `print`, `calibrate`, `gen-goo`, `upload`, `expose`, `stop`. |
| **Project model**| `crates/cuprum-project`| The self-contained `.cuprum` project container and the recents catalog. |
| **Desktop UI**   | `cuprum-ui`            | Tauri 2 + React app: native-sharp preview, CAD-style navigation (zoom-to-cursor, pan, grid, snapping), multi-select, alignment/auto-layout, 3D board view, and one-click exposure. |

## Build & run

### Prerequisites

- [Rust](https://rustup.rs/) (stable, edition 2021)
- For the desktop UI: [Node.js](https://nodejs.org/),
  [pnpm](https://pnpm.io/), and the
  [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  platform.

### CLI

```sh
# Build the whole workspace
cargo build --release

# Find a printer on the LAN
cargo run -p cuprum-cli -- discover

# Inspect a Gerber file
cargo run -p cuprum-cli -- gerber-info path/to/board.gbr

# Render a Gerber to a PNG preview (no printer involved)
cargo run -p cuprum-cli -- render path/to/board.gbr out.png
```

Run `cargo run -p cuprum-cli -- --help` for the full command list.

> ⚠️ The `expose` and `print` commands **fire the UV screen**. Remove the build
> plate first.

### Desktop UI

```sh
cd cuprum-ui
pnpm install
pnpm tauri dev
```

## Repository layout

```
crates/          Rust workspace (core, cli, project model)
cuprum-ui/       Tauri 2 + React desktop app
vendor/          Vendored dependencies (see Acknowledgements)
testdata/        Sample Gerber files
spikes/          Throwaway scripts used while reverse-engineering the protocol
docs/            Vision, design system, and development notes
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for contributor notes (notably:
bump the relevant disk-cache version tag when you change derived output).

## Acknowledgements

- Gerber rendering builds on
  [MakerPnP/gerber-viewer](https://github.com/MakerPnP/gerber-viewer)
  (MIT OR Apache-2.0), vendored under `vendor/gerber-viewer`.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or
  <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or
  <http://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
