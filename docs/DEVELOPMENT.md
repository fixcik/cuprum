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

## Documentation

- `docs/VISION.md` — product vision and roadmap (CAM system for home PCB production).
- `docs/DESIGN.md` — design system (palette, typography, components) and the
  log of design decisions.
