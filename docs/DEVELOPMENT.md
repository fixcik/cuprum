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
