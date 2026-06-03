# Development notes

## Bump the cache version when you change derived output

Derived artifacts are cached on disk, keyed by a hash of `(source + version tag)`
— see `crates/cuprum-core/src/diskcache.rs`. **If you change logic that affects
the output, you must bump the corresponding version tag**, otherwise users will
get a stale result from the cache. The tags live in one place,
`crates/cuprum-core/src/artifact.rs` (`SVG_VERSION` / `METRICS_VERSION` /
`PREVIEW_VERSION`) — except `mesh-vN`, still built in `cuprum-ui/src-tauri/src/main.rs`:

| Tag          | Covers                        | Bump when editing |
|--------------|-------------------------------|-------------------|
| `svg-vN`     | layer rendering to SVG        | `svg.rs` |
| `metrics-vN` | DFM measurements (`BoardMetrics`) | `metrics.rs`, `geometry.rs` (measurements: `clearance_width_hotspots` / `seg_seg_closest` / `*_hotspots`), `drill.rs` |
| `preview-vN` | design-card preview PNG composition | `preview.rs` (palette / z-order / mask coverage / `PREVIEW_MAX_PX`) |
| `mesh-vN`    | 3D mesh triangulation         | `mesh.rs`, `geometry.rs` (polygons: `layer_polygons` / `fill_polygons` / `contours_of`) |

A change in `geometry.rs` can touch **both** mesh (if polygons are affected)
**and** metrics (if measurements are affected) — bump both relevant tags.

### Project-embedded artifacts (`<workdir>/artifacts/`)

`svg`, `metrics`, and `preview` artifacts are **persistent** (no TTL/eviction) and
live under `<workdir>/artifacts/{svg,metrics,preview}/<key>.bin`, so they are packed
into the `.cuprum` by `workdir::pack` and a transferred project never recomputes
them. Invalidation is purely by content-hash key (the version tag is part of the
filename): bump a `*_VERSION` and the old blobs simply stop matching, get
regenerated on read, and are swept on the next `pack` by `artifact::gc` (which keeps
only keys the current manifest still references). `mesh` stays in the global OS
app-cache (TTL + LRU). `CUPRUM_NO_CACHE` bypasses the project artifacts too.

### Restore-point retention & gerber GC

Restore points (`history/<id>.json`) carry an `auto: bool` (legacy snapshots
without the field default to `true`). `history::prune` (run on every `write`)
applies `select_pruned` — a pure, testable policy: **manual** points (`auto=false`,
the 💾 button) are pinned (kept up to `MAX_MANUAL_POINTS`), **auto** points
(auto-on-open) are GFS-thinned by age (keep all <24h, newest per day to 7d, newest
per week to 8wk, then drop), and an auto point that references **no design still in
the live manifest** is dropped past 48h (low value, and it pins orphaned gerbers).
Constants live atop `history.rs`. A snapshot that fails to migrate contributes an
*unknown* design set and is never staleness-pruned (fail toward retention).

`workdir::pack` then reclaims orphaned gerber dirs: `gc_gerbers` removes
`gerbers/<id>/` not referenced by the current manifest **nor any retained restore
point** (`live_gerber_dirs` unions both). If any restore point can't be read/
migrated, `live_gerber_dirs` returns `None` and GC is skipped that pass — an
un-reclaimed orphan is harmless, deleting a gerber a point still needs is not.

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
| `CUPRUM_TRACE_SESSION_IDLE_MS=…` | idle window (ms) before the backend finalizes a load **session** (default `1500`) — see below |

A traced operation normally writes **one** Chrome Trace Event JSON file
(`<op>_<seq>_<ts>.json`). The absolute path of every file is printed to stderr
(`cuprum: trace → …`), so you don't have to hunt for it. Default directories:

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

### Forcing a cold path: `CUPRUM_NO_CACHE`

For repeatable profiling set `CUPRUM_NO_CACHE=1` to bypass **all** caches — the disk
artifact cache (`diskcache`) and the in-memory preview/mask/SVG caches (`cache.rs`) — so
every operation recomputes from cold instead of serving a cached result. Results are
unchanged (recompute vs. serve). Combine with tracing to capture cold traces:

```sh
cd cuprum-ui && CUPRUM_TRACE=1 CUPRUM_NO_CACHE=1 pnpm tauri dev
```

With the cache bypassed, repeated/duplicate computations each recompute and write
their own trace — e.g. React StrictMode double-invokes effects in dev, and several
components may request metrics for the same design — so you'll see more trace files
than with the cache on.

Mechanism: `cuprum_core::trace::operation(name, dir, f)` installs ONE
process-global subscriber (once per process, via
`tracing::subscriber::set_global_default`) carrying a custom `RoutingLayer`. Each
call registers an `OpSink` (its own file) under a unique monotonic `op_id`, then
enters a root span that carries that id. `RoutingLayer` resolves a span's op-id
(the root span's own field, else inherited from the parent span's cached
metadata) and writes Chrome `B`/`E` events to that op's file on span
enter/exit. Spans are created with `#[tracing::instrument]` / `info_span!` in
`cuprum-core` and are near-zero when tracing is disabled. Concurrent UI
operations get distinct files (routing is by `op_id`, not by thread), so they no
longer cross-contaminate. Rayon worker spans are routed correctly: capture the
current span on the parent thread with `capture_dispatch()` and re-enter it on
each worker via `DispatchHandle::run` — worker spans then inherit the op-id and
land in the right file. (A process-global subscriber is required here: a
thread-scoped one is silently bypassed on shared rayon pool workers under
concurrency, dropping their spans.)

**Tracing does not change derived output**, so the cache version tags above do
**not** need bumping when you add or move spans.

### Load sessions (one file for the whole import)

A single design-load spans several Tauri commands (import, then the per-card
`preview`/`metrics`/`svg` precompute) fired close together from the frontend. To
see them on **one** timeline with a shared time origin (so you can read the real
wall-clock overlap), they are grouped into a **trace session** — one
`load_<seq>_<ts>.json` file.

The session is **backend-owned**: `add_design_from_zip` opens it
(`trace::begin_session("load", …)`) and runs the import as its first operation;
the returned opaque token is passed back to the frontend, which only forwards it
(as `traceSession`) into that design's `preview`/`metrics`/`svg` calls — the
frontend makes no lifecycle decision. Those commands join the session via
`trace::operation_in_session(token, …)` instead of opening their own file. The
session is **closed by the backend**: a lazily-spawned idle-reaper thread
finalizes a session once it has no in-flight operation and has been idle for
`CUPRUM_TRACE_SESSION_IDLE_MS` (default 1500 ms). A long single operation keeps
the session open (its op count stays > 0), so it never closes mid-work.

Designs opened from disk (no import) carry no token, so their precompute commands
fall back to one file per operation, exactly as before. The **flush**
(`save_project` → `workdir::pack`) is deliberately its OWN operation/file, not part
of the session, because it is debounced ~1.5 s later on the frontend.

### Operations (one trace file each)

| Operation | Where | Heavy work captured |
|-----------|-------|---------------------|
| `render`  | UI `render_preview`, CLI `render` | `gerber::parse_file`, `render_preview_png` |
| `compose` | UI `run_print`, CLI `prepare`/`render` | `compose::compose_layout` (+ `rasterize`/`invert` spans), `goo::single_layer_exposure`/`serialize` |
| `mesh`    | UI `project_board_mesh` (cache miss) | `mesh::board_geometry` (+ `triangulate_parallel`), polygon builders |
| `metrics` | UI `project_board_metrics` (cache miss) | `metrics::board_metrics`; per-layer `geometry::clearance_width_hotspots` run in parallel (rayon) |
| `svg`     | UI `render_layers_svg` / `render_gerber_svg` (cache miss) | `svg::render_layer_svg` |
| `preview` | UI `render_design_preview` (cache miss) | `preview::render_design_preview` (compose + `resvg` raster) |
| `import`  | UI `add_design_from_zip` (first op of the `load` session) | `read_zip`, `write_gerbers` |
| `flush`   | UI `save_project` | `workdir::pack` (`read_manifest`, `compute_valid_keys`, `artifact_gc`, `gerber_gc`, `collect_entries`, `zip_write`) |
| `gerber-info` | CLI `gerber-info` | `gerber::parse_file` |

`preview`/`metrics`/`svg` triggered right after an `import` join that import's
`load` session file instead of writing their own (see *Load sessions* above).

UI operations that go through the artifact cache (`mesh`/`metrics`/`svg`) only
write a trace on a **cache miss** (in-memory or disk) — a cache hit does no heavy
work, so there is nothing to profile.

### Кеш SVG-слоёв и preview

Рендер слоя в SVG кешируется в core (`cache.rs`, `layer_svg_artifact`): сначала
in-memory, затем **персистентный** дисковый кеш в `<workdir>/artifacts/svg`, иначе
рендер. Ключ — content-hash гербера (`hash(SVG_VERSION + bytes)`), поэтому
неизменённый файл не пересчитывается, а блоб едет в `.cuprum`. Параллельные промахи
по одному ключу дедуплицируются (single-flight): рендерит один поток, остальные
ждут и берут готовый результат; рендеры разных слоёв идут параллельно. Первичная
загрузка слоёв в UI (инспектор) идёт пакетной командой `render_layers_svg` (rayon,
один IPC-вызов вместо одного на слой); одиночный `render_gerber_svg` — для точечного
переотображения слоя.

Карточка дизайна показывает не живой SVG-стек, а готовое растровое превью: команда
`render_design_preview` собирает в core (`preview.rs`) цветной композит top-стороны
(FR4-подложка + слои в z-порядке; маска — инвертированное покрытие платы минус
вскрытия), растеризует через `resvg` в PNG (`PREVIEW_MAX_PX`) и персистит в
`<workdir>/artifacts/preview`. Трейс-операция — `preview`.

### Instrumented spans (in `cuprum-core`)

- `gerber.rs`: `parse_file`, `render_preview_png`
- `geometry.rs`: `layer_polygons`, `copper_polygons`, `region_polygons`,
  `mask_polygons`, `fill_polygons`, `clearance_width_hotspots` (with internal
  `grid_build` / `sweep` / `width_filter` sub-spans)
- `metrics.rs`: `board_metrics`; sub-analyses `parse_layer`, `conductor_model`,
  `thin_stroke_hotspots`, `annular_hotspots`. The per-layer
  `clearance_width_hotspots` clearance and width passes run concurrently (rayon).
- `mesh.rs`: `board_geometry` + `triangulate_parallel` (the rayon section)
- `compose.rs`: `compose_layout` + `rasterize` + `invert` (the rayon sections)
- `goo.rs`: `single_layer_exposure`, `serialize`
- `svg.rs`: `render_layer_svg`
- `diskcache.rs`: `get` (records a `hit` = true/false field), `put` (with a
  `prune` child span), `put_persistent`

Spans also live in `cuprum-project` (the import + flush path), routed through the
same process-global subscriber:

- `import.rs`: `read_zip` (records a `files` count)
- `lib.rs`: `write_gerbers` (records a `files` count)
- `document/workdir.rs` (`pack`): `read_manifest`, `compute_valid_keys`,
  `artifact_gc`, `gerber_gc`, `collect_entries` (records `files` + `bytes`)
- `document/container.rs` (`write`): `zip_write` (records an `entries` count) —
  the ZIP deflate, usually the heaviest part of a flush

Heavy inner loops (e.g. `geometry::seg_seg_closest`) are intentionally not
instrumented per-iteration — only the enclosing phase span is.

The `metrics` per-layer `clearance_width_hotspots` calls run on rayon worker
threads. The operation's tracing dispatcher + current span are propagated onto
those workers (see `copper_clearance_width_hotspots`), so their spans — and the
`grid_build`/`sweep`/`width_filter` children — **are** captured in the `metrics`
trace, appearing on the worker threads' tracks in Perfetto.

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
