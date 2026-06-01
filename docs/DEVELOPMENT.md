# Development notes

## Bump the cache version when you change derived output

Derived artifacts are cached on disk, keyed by a hash of `(source + version tag)`
— see `crates/cuprum-core/src/diskcache.rs`. **If you change logic that affects
the output, you must bump the corresponding version tag**, otherwise users will
get a stale result from the cache. The tags live in
`cuprum-ui/src-tauri/src/main.rs`:

| Tag          | Covers                        | Bump when editing |
|--------------|-------------------------------|-------------------|
| `svg-vN`     | layer rendering to SVG        | `svg.rs` |
| `mesh-vN`    | 3D mesh triangulation         | `mesh.rs`, `geometry.rs` (polygons: `layer_polygons` / `fill_polygons` / `contours_of`) |
| `metrics-vN` | DFM measurements (`BoardMetrics`) | `metrics.rs`, `geometry.rs` (measurements: `clearance_width_hotspots` / `seg_seg_closest` / `*_hotspots`), `drill.rs` |

A change in `geometry.rs` can touch **both** mesh (if polygons are affected)
**and** metrics (if measurements are affected) — bump both relevant tags.

## Tracing / profiling

Heavy pipeline phases are instrumented with [`tracing`](https://docs.rs/tracing)
spans. Tracing is **off by default** and compiled into every build (including
release — profile optimized builds, not debug). Enable it at runtime via the
`CUPRUM_TRACE` env var:

| Value | Behavior |
|-------|----------|
| unset | tracing sleeps (default) |
| `CUPRUM_TRACE=1` / `on` / `true` | on, default directory |
| `CUPRUM_TRACE=/path/to/dir` | on, write traces there |
| `CUPRUM_TRACE_FILTER=…` | optional [`EnvFilter`](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html) directive (default: capture everything) |

Each traced operation writes **one** Chrome Trace Event JSON file (`<op>_<seq>_<ts>.json`).
The absolute path of every file is printed to stderr (`cuprum: trace → …`), so you
don't have to hunt for it. Default directories:

- **UI:** `app_cache_dir()/traces` (sibling of the artifact cache).
- **CLI:** `./cuprum-traces/` in the current directory.

**View a trace:** open the JSON in <https://ui.perfetto.dev> — you get a timeline
with nested spans and per-thread tracks (rayon parallelism included).

```sh
# CLI example
CUPRUM_TRACE=1 cargo run -p cuprum-cli -- render testdata/board.gbr -o /tmp/out.png
# UI example
cd cuprum-ui && CUPRUM_TRACE=1 pnpm tauri dev
```

Mechanism: `cuprum_core::trace::operation(name, dir, f)` runs `f` under a
thread-scoped subscriber + `tracing-chrome` layer. Spans are created with
`#[tracing::instrument]` / `info_span!` in `cuprum-core` and are near-zero when no
subscriber is active. Because the work runs synchronously on one thread, all its
spans land in that operation's file; parallel UI operations run on distinct
threads and so get distinct files. Rayon parallel loops are wrapped by a single
span on the parent thread (we don't instrument per-iteration).

**Tracing does not change derived output**, so the cache version tags above do
**not** need bumping when you add or move spans.

### Operations (one trace file each)

| Operation | Where | Heavy work captured |
|-----------|-------|---------------------|
| `render`  | UI `render_preview`, CLI `render` | `gerber::parse_file`, `render_preview_png` |
| `compose` | UI `run_print`, CLI `prepare`/`render` | `compose::compose_layout` (+ `rasterize`/`invert` spans), `goo::single_layer_exposure`/`serialize` |
| `mesh`    | UI `project_board_mesh` (cache miss) | `mesh::board_geometry` (+ `triangulate_parallel`), polygon builders |
| `metrics` | UI `project_board_metrics` (cache miss) | `metrics::board_metrics`, `geometry::clearance_width_hotspots` |
| `svg`     | UI `render_gerber_svg` (cache miss) | `svg::render_layer_svg` |
| `gerber-info` | CLI `gerber-info` | `gerber::parse_file` |

UI operations that go through the artifact disk cache (`mesh`/`metrics`/`svg`)
only write a trace on a **cache miss** — a cache hit does no heavy work, so there
is nothing to profile.

### Instrumented spans (in `cuprum-core`)

- `gerber.rs`: `parse_file`, `render_preview_png`
- `geometry.rs`: `layer_polygons`, `copper_polygons`, `region_polygons`,
  `mask_polygons`, `fill_polygons`, `clearance_width_hotspots`
- `metrics.rs`: `board_metrics`
- `mesh.rs`: `board_geometry` + `triangulate_parallel` (the rayon section)
- `compose.rs`: `compose_layout` + `rasterize` + `invert` (the rayon sections)
- `goo.rs`: `single_layer_exposure`, `serialize`
- `svg.rs`: `render_layer_svg`
- `diskcache.rs`: `get` (records a `hit` = true/false field), `put`

Heavy inner loops (e.g. `geometry::seg_seg_closest`) are intentionally not
instrumented per-iteration — only the enclosing phase span is.

## CI & releases

Two GitHub Actions workflows live in `.github/workflows/`:

- **`ci.yml`** — runs on every push/PR to `master`: rustfmt + clippy
  (`-D warnings`) on the Rust workspace, `cargo test`, and a UI job that
  type-checks + builds the frontend and `cargo check`s the Tauri backend.
- **`release.yml`** — a manual (`workflow_dispatch`) release. It:
  1. computes the next version from Conventional Commits across the whole repo
     with [git-cliff](https://git-cliff.org) (or takes an explicit `version`
     input), and updates `CHANGELOG.md`;
  2. stamps that version into every manifest via `scripts/set-version.sh`
     (Rust workspace, the Tauri crate, `tauri.conf.json`, and `package.json`)
     so the app reports it through `getVersion()`;
  3. commits + tags `vX.Y.Z`, drafts a GitHub release with generated notes;
  4. builds the desktop bundles (macOS universal, Linux, Windows) and attaches
     them, then publishes the release.

  Use the `dry_run` input to preview the version + changelog without tagging.
  The default `GITHUB_TOKEN` is enough unless branch protection blocks the
  release commit — then provide a PAT.

Conventional Commit prefixes (`feat`, `fix`, `perf`, …) drive both the version
bump and the changelog grouping (see `cliff.toml`). `feat` → minor, breaking
(`!` / `BREAKING CHANGE`) → major, everything else → patch.

## Documentation

- `docs/VISION.md` — product vision and roadmap (CAM system for home PCB production).
- `docs/DESIGN.md` — design system (palette, typography, components) and the
  log of design decisions.
