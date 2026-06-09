## [0.4.0] - 2026-06-04

### Features

- **panel**: Live preview in registration-set dialog (#146)
- **ui**: Panel-level DFM verdict — phase A (evaluatePanel + editor) (#140)
- **ui**: Add Open design button to selection HUD; move rotation knob to bottom-right corner (#144)
- **panel**: Parameterized registration-set dialog (layout/margin/diameter + add or replace) (#143)
- **ui**: Floating selection HUD on panel canvas; move rotation knob to corner; drop right-dock placement section (#141)
- **panel**: Tooling tool is edit-first; explicit armed Add-hole with ghost cursor (#139)
- **ui**: Numeric placement inspector (X/Y/rotation) for the selected board instance (#134)
- **ui**: Highlight off-panel instances in red on the panel canvas (#136)
- **ui**: Snap panel hover crosshair to blank/instance corners/edges/centers; Alt bypasses (#128)
- **ui**: Snap hover crosshair to features/edges/corners like the ruler; Alt/Option bypasses snapping for both (#126)
- **ui**: Re-arrange selected panel instances (re-nest modal) (#125)
- **cli**: Check --hotspots flag (omit located hotspots from output by default) (#122)
- **ui**: "open design" in panel instance context menu (#121)
- **cli**: Check — DFM metrics + manufacturability gate (#119)
- **cli**: 3d — export board mesh (glTF/STL/OBJ) (#118)
- **cli**: Render (composite PNG) + svg (composite SVG) (#117)
- **cli**: Rewrite as toolbox — foundation (resolve_design, info, drop legacy) (#116)
- **ui**: Magnetic smart guides while dragging panel instances (#111)
- **ui**: Converge design preview onto shared RulersOverlay + toggleable hover crosshair (#113)
- **ui**: Dynamic rulers + adaptive grid on the panel canvas (shared SVG overlay) (#110)
- **ui**: Panel align/distribute bar for multi-selection (#107)
- **ui**: Panel canvas context menu (duplicate/rotate/reset/delete) (#105)
- **ui**: Readable ruler overlay — copper core over dark casing + snap reticles (#100)
- **ui**: Precise rotated-AABB clamp for panel nudge & duplicate (#101)
- **ui**: Panel editor — free rotation + duplicate (3/3) (#94)
- **ui**: Panel editor — selection, move, delete (2/3) (#92)
- **ui**: Panel instance pose — centre-pivot geometry + rendering (1/3) (#87)
- **core**: Report all DFM hotspots (cap 40→500) + unify drill/via dedup (metrics-v17) (#79)
- **ui**: Schematic design preview in add-design window — usePreviewData hook (Phase 3) (#69)
- **ui**: Open design inspector in a separate window (multi-window) (#70)
- **ui**: Convert panel/nesting unit fields to active units (mm/inch/mil) (#68)
- **ui**: Filter DFM hotspot overlay by problem type (funnel popover + right-click menu) (#64)
- **ui**: Panel auto-placement (nesting) — settings + packer + live preview (Phase 2) (#61)
- **ui**: Native menu with manual "Check for updates" (#57)
- **ui**: In-app auto-update (updater plugin + startup check + banner) (#55)
- **ui**: Add design to panel — separate window, picker & placement (Phase 1) (#53)
- **ui**: Redesign home — new-project tile, monogram previews, recent-card context (#52)
- **ui**: Block double-sided design on a single-sided panel (#51)
- **core**: Coalesce connected line segments into polyline runs (#47)
- **ui**: Spin the save icon while a .cuprum repack is in flight (#42)
- **ui**: Preview & recents polish (#41)
- **trace**: Single end-to-end trace for design load (#40)
- 3D board uses panel stackup substrate thickness (mesh-v5) (#39)
- **core**: Trace mesh build phases (#37)
- **ui**: Precompute design artifacts + prep progress (ring + global chip) (#35)
- **ui**: Rename designs + verdict-toned inspector tabs (#33)

### Bug Fixes

- **ui**: Keep panel tool palette off the rulers; slimmer ruler bands
- **ui**: Keep segmented-control labels on one line; tighten tooling diameter field (#138)
- **panel**: Make tooling holes clickable/draggable (add hit target) (#137)
- **ui**: Larger board gap never fits more copies (greedy free-space fill) (#130)
- **ui**: Cascade-remove panel placements when deleting a design; confirm when placed (#131)
- **ui**: Panel ruler uses muted accent (not copper, like the inspector) (#127)
- **ui**: Stop hover crosshair re-rasterizing DRC overlay; make ruler/crosshair mutually exclusive; Esc backs out of both (#124)
- **ui**: Mute the design-preview ruler accent (copper stays panel-only) (#115)
- **ui**: Snug single copy ignores edge margin so a fitting board is placeable (#89)
- **ui**: Off-panel warning false-positive on rotated nested instances (#77)
- **ui**: Keep DFM issue stepper on the toolbar row (not a lower row) (#66)
- **ui**: Move DFM type filter into the overlay pill and stepper to its own row (#65)
- **ui**: Keep placed designs when editing panel size/stackup (#62)
- **ui**: Persist oversized panel size — work-area limit is advisory, not a save gate (#58)
- **ui**: Flag oversized panel dimensions instead of silently clamping (#56)
- **project**: Persist panel edits via working-dir autosave; drop obsolete configure_panel (#54)
- **ui**: Plain-language double-sided hint (no "stackup" jargon)
- **ui**: Don't clip silk/copper layers — WKWebView beads thin strokes under zoom (#46)
- **ui**: Inspector outline clip uses evenodd so board cutouts punch holes (#45)
- **core**: Clip card preview composite to the board outline (preview-v3) (#44)
- **ui**: Flush render artifacts into the .cuprum after viewing (#34)

### Other

- Tooling-hole placement tool + unified placement obstacles (#133)

* feat(panel): tooling-hole geometry + unified placement obstacles

* feat(panel): tooling-hole store mutations; nesting avoids holes

* feat(panel): tooling-hole tool — palette, canvas render + edit

* feat(panel): add-design preview avoids tooling holes (WYSIWYG)

* docs: roadmap — tooling-hole tool done; keep-out zones via panelObstacles

* fix(panel): re-nest and add-design preview avoid tooling holes consistently

* docs: roadmap — tooling-hole tool PR ref (#133)
- Panel canvas: neutral structure, copper reserved for selection (#123)

* feat(panel): neutral canvas structure, copper reserved for selection

* docs: roadmap — panel accent hierarchy (#123)
- Redesign panel settings into a collapsible right inspector (#114)

* feat(ui): panel-inspector UI-state slice, stackup helper, i18n

* feat(ui): StackupDiagram — live FR4 cross-section

* feat(ui): PanelInspector right-dock component

* feat(ui): panel editor — canvas-hero layout with collapsible right inspector

* fix(ui): panel inspector pointercancel, stackup-aware preset match, unit-safe over-area alert

* docs: mark panel inspector redesign done in roadmap

* docs: link panel inspector roadmap entry to PR #114
- Add-to-panel packs into free cells, clear of placed instances (#108)

* feat(ui): packLayoutAvoiding — grid-pack into cells free of existing instances

* feat(ui): add-to-panel packs into free space, keeping clear of placed instances

* feat(ui): add-to-panel preview shows placed instances and free-cell placement

* docs: mark add-to-panel free-cell placement done in roadmap

* docs: link free-cell placement roadmap entry to PR #108
- Redesign the project Designs tab (#102)

* feat(ui): designs-tab i18n, verdict rollup helper, import counter

* feat(ui): preselect design when opening add-to-panel window

* feat(ui): richer design card with verdict chip, hover actions, on-panel badge

* feat(ui): redesign designs gallery with header, summary, search, empty/import states

* fix(ui): deliver add-to-panel preselect to an already-open window without leaking pending id

* docs: mark designs-tab redesign done in roadmap

* docs: link designs-tab redesign roadmap entry to PR #102

### Performance

- **ui**: Measure feasibility derivations (~1.4ms worst-case) — Web Worker offload not warranted (#95)
- **core**: Xxh3-128 cache hasher + read gerbers once per pack (flush prereqs) (#72)
- **core**: Shared cross-operation gerber parse cache (parse-once) (#63)
- **core**: Preview reuses shared per-layer SVG cache (render-once) (#59)
- **core**: Inline edge geometry in sweep grid buckets — cache-friendlier clearance (#50)
- **core**: Render coalesced line runs as one polyline path (svg-v2) (#49)
- **core**: Stroke line runs once with round joins — lighter union for metrics/mesh (metrics-v16, mesh-v6) (#48)
- Faster .cuprum flush (per-entry compression + incremental repack + coalescing) (#43)
- **core**: Faster 3D mesh build (substrate once + parallel with layers) (#38)

### Refactor

- Move mesh cache version tag into artifact.rs (#145)
- **ui**: Split src-tauri main.rs into commands/* modules (#142)
- **gerber**: Drop unused GerberImageTransform (MI/SF/OF/IR/AS unsupported) (#132)
- **gerber**: Split forked parsing core into focused modules (#129)
- **gerber**: Vendor-fork gerber-viewer parsing core, drop egui rendering (#120)
- Extract cuprum-dfm crate and relieve metrics/mod.rs (#112)
- Extract cuprum-mesh crate and split mesh.rs into submodules (#109)
- **ui**: Extract Tauri listener hooks, fix StrictMode async-cleanup leak in bridges (#104)
- Extract cuprum-gerber crate and split geometry.rs into submodules (#106)
- **core**: Extract .goo encoding + screen geometry into cuprum-goo leaf crate (#103)
- **ui**: Extract useDesignVerdict hook + VerdictDot, dedup card/row verdict logic (#99)
- **core**: Extract single-flight cache engine into cuprum-cache leaf crate (#98)
- **ui**: Extract PanelStatus for centered loading/empty preview states (#97)
- **core**: Relocate cache wrappers to svg/dfm, cache keeps engine + facade (#96)
- **core**: Move parse_layer_cached into gerber to break cache cycles (#90)
- **ui**: Extract FormModal + LabeledTextInput, dedup the three name/description dialogs (#88)
- **ui**: Unify severity styles + finding-text resolver into shared lib/hook (#83)
- **core**: Extract printer protocol into a cuprum-sdcp leaf crate (#84)
- **ui**: Converge DesignInspector onto usePreviewData hook (#81)
- **ui**: Extract pure unit-format core and cover it with tests (#82)
- **trace**: Split cuprum-trace into config/sink/layer/session modules (#80)
- **core**: Extract cuprum-diskcache crate; split diskcache into hash/store modules (#76)
- **core**: Extract tracing into a cuprum-trace leaf crate (#73)
- **core**: Group all DFM code into a dfm/ module (#36)

### Documentation

- Vision — equipment as a first-class machine registry (per-process DFM)
- Fix stale crate paths in cache-tag docs; note mesh-tag tech debt
- **roadmap**: Derive panel min-gap from cutter diameter (future)
- Off-panel red highlight (roadmap + design log, PR #136)
- Drop stale vendor/ references (README, svg.rs comments) (#135)
- **roadmap**: Highlight panel area outside the machine work zone
- Vision — drop the explicit no-primacy sentence
- Vision — milling and UV as co-equal copper-pattern methods (no primacy)
- Roadmap — restore lost panel-verdict bullet header
- **roadmap**: Correct re-nest PR number (#125)
- **roadmap**: Bug — larger board gap fits MORE copies in nesting
- CLI rewrite v1 complete (Phase 3 + README commands)
- Roadmap — CLI rewrite Phase 2 shipped (#118)
- Roadmap — CLI rewrite Phase 1 shipped (#117)
- Roadmap — CLI brainstorm done, rewrite Phase 0 shipped (#116)
- **roadmap**: Add "open design" to panel instance context menu
- Reflect frontend test coverage across all phases in roadmap
- **roadmap**: Offload CPU-bound frontend work to a worker to keep UI responsive
- **roadmap**: Plan full from-scratch rewrite of the ancient CLI crate
- Panel editor v1 = free rotation; defer align/distribute, guides, re-nest, tooling
- Roadmap — panel context menu as a follow-up to the interactive editor
- Spell out selection (single+bulk), move/rotate/delete in panel editor item
- Link feasibility metrics coverage to PR #67
- Roadmap — pack_board_mesh optimization investigated, not worth it (release ~5ms)
- **roadmap**: Clarify panel DFM verdict is panel-level and blocked on placement
- Roadmap — updater signing secret added (one secret, empty password)
- Roadmap — задачи из бэклога (keep-out, автообновление, DFM-двусторонка, калибровка, фронт-тесты)
- **roadmap**: Record flush optimization (PR #43) and next flush target
- Backlog — silk renders beaded at high zoom (per-segment round caps)
- Roadmap targets for mesh perf (longest layer + pack serialization)
- Roadmap — render SVG layer once (preview reuses cached per-layer SVG)

### Testing

- **ui**: Cover shell store view, artifact-progress and undo bookkeeping (#93)
- **ui**: Cover layout store pure actions (select/align/distribute/arrange) (#91)
- **ui**: Cover settings store actions (#86)
- **ui**: Cover board-mesh parsing and outline stitching (#85)
- **ui**: Cover relative-time and language helpers (#78)
- **ui**: Cover artifact progress and project-error helpers (#75)
- **ui**: Cover panel placement geometry (#74)
- **ui**: Cover layerColors and panel pure helpers (#71)
- **ui**: Cover feasibility metric-driven findings (#67)
- **ui**: Add vitest runner and cover feasibility DFM logic (#60)

### Chores

- Drop Phase 0 protocol-spike scripts (now in cuprum-sdcp)

