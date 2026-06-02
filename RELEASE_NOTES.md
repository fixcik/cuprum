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

