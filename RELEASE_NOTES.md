## [0.5.1] - 2026-06-10

### Features

- **i18n**: Gate t() keys in code against locale JSON (#559)

### Bug Fixes

- **ui**: Move global border-color default into @layer base so colour utilities win (#575)
- **nest,cache,gerber**: Guard against NaN-sort and cache-mutex poisoning panics (#572)
- **ui**: Restore Tailwind border/bg opacity classes on tool-change card, add generator canary test (#570)
- **core,trace,project,sdcp**: Preview key max_px, trace RAII, override matching, discovery deadline (#563)
- **tauri**: Machine_connect TOCTOU, confined workdir on restore commands, status echo generations (#562)
- **ui**: Live manifest re-read on import, StrictMode-safe listeners, NaN guard, preview reload (#560)
- **gerber**: Parser panics, G74 arcs, macro unary minus, winding; dfm worst-pad annular (#557)

### Performance

- **panel**: Sweep-line candidate pairs in evaluatePanel overlap/spacing checks (#571)
- **ui**: Dedup project_board_metrics IPC via single-flight promise cache (#567)
- **ui**: Replace O(n²) silk clusterBoxes with bucket-grid union-find (#558)

### Refactor

- **ui**: Extract shared ZoomToolbar for the three Konva canvases (#574)
- **commands**: Unify Tauri command errors into CmdError (#569)

### Documentation

- Roadmap 14 crates (add nest/drill), DEVELOPMENT revision date

