# Changelog

All notable changes to Cuprum are documented here.
This project follows [Conventional Commits](https://www.conventionalcommits.org)
and [Semantic Versioning](https://semver.org).

## [0.5.0] - 2026-06-09

### Features

- **machine**: Reach travel edges — 0.01mm jog margin + clamp to live GRBL max-travel (#524)
- **drill**: Cancelable soft stop — keep running if canceled mid-hole (#522)
- **drill**: Include the homing leg to work zero in the route and G-code (#519)
- **drill**: Redesign run footer (pause/stop + dominant e-stop), feed scale, green finish (#517)
- **drill**: Full manual Z touch-off bar (live Z, click-jog, hover, previous-Z mark) (#513)
- **drill**: Return to work zero (0,0) at end of drill program (#506)
- **drill**: Redesign tool-change/Z-attach card on warning tokens + two-step probe (#505)
- **drill**: Hover crosshair with X,Y readout on the board-on-bed map (#502)
- **machine**: Async-actor GRBL connection (tokio-serial) (#493)
- **ui**: Restore the open project across webview reload / app restart (#486)
- **grbl**: Describe spindle PWM settings ($33-$36) in the settings tab (#485)
- **machine**: Respect GRBL min spindle speed ($31) as the slider floor (#481)
- **ui**: GRBL settings tab in the CNC machine editor (#474)
- **ui**: GRBL settings catalog, helpers, and i18n (#471)
- **ui**: Restyle equipment device-list rows and collapsed rail (#449)
- **ui**: Add-device screen with model presets and empty state (#448)
- **drill**: Redesign work-zero panel (Variant B) — hero XY pad + Z touch-off strip (#447)
- **ui**: Card-based equipment settings tab (work-zone viz, search, reset-to-factory) (#446)
- **panel**: Recommended cut-gap constant + Auto gap button (#440)
- **settings**: Add a Z-probe on/off toggle + probe params to the machine profile (#434)
- **machine**: Auto-hide console drawer on pop-out + hide action cluster when disconnected (#433)
- **drill**: Add a Z jog bar to the work-zero screen for aiming (#432)
- **panel**: Mix-orientation toggle in the renest dialog (#430)
- **machine**: Self-sufficient console window + connection (global broadcasts) (#420)
- **operations**: Run history as clickable cards beside the operation buttons (#415)
- **machine**: Reusable AlarmActions (unlock + open console) on alarm banners (#414)
- **machine**: Console window — action toolbar via injection (Phase 2) (#413)
- **machine**: Console window — display relay (Phase 1) (#408)
- **ui**: Tune design inspector header — gear-based rename + shared NavTabs (#390)
- **drill**: Match design for the XY jog pad (3×3 + go-to-zero, X/Y badges, step in header) (#386)
- **drill**: XY-only work-zero binding (Z is taken per-bit) (#382)
- **ui**: Auto-name panel presets on save and make them deletable (#383)
- **drill**: Per-tool Z touch-off in the run (probe/manual, self-test, gate) (#375)
- **machine**: Z-probe backend — G38.2 probe, parsing, machine_probe_z command (#372)
- **machine**: Echo the status reply when the user types ? in the console (#361)
- **drill**: V2 high-fidelity polish for the drill operation screen (#356)
- **drill**: Board-on-bed mini-map with travel-fit check and click-to-move (#355)
- **drill**: Work-zero binding as an inspector mode + plan declutter (#354)
- **machine**: Spindle gauge as % of GRBL $30, live RPM apply, datum picker in control panel (#353)
- **drill**: Gate the run when the work zero pushes holes past XY travel (#348)
- **machine**: Reattach to a live connection after a webview reload (#345)
- **machine**: Drop click-to-move raise-Z confirm, always raise then move (#342)
- **machine**: Compact the control column (denser DRO, jog, spindle; narrower) (#341)
- **machine**: Stuck-limit recovery mode (nudge off switch, restore limits, home) (#336)
- **grbl**: Parse Pn limit/probe pin state from status reports (#335)
- **machine**: Cancel-and-retarget click-to-move for work field and Z bar (#326)
- **machine**: Homing progress overlay + ok-based completion detection (#323)
- **machine**: Clickable Z bar + duplicate Z jog buttons sharing jog step (#322)
- **drill**: Three-phase per-hole progress ring (descent/drilling/retract) (#311)
- **drill**: Bind work X-Y zero at the datum corner; gate start on X-Y and Z (#310)
- **drill**: Show live Z in the machine-position marker readout (#282)
- **drill**: Unlock/reset machine from the ALARM banner in the drill window (#268)
- **ui**: Machine model + settingsStore migration (epic #202 foundation) (#256)
- **drill**: Configurable work-zero datum corner (#257)
- **drill**: Live-sync CNC profile and tools to the drill window via the snapshot bridge (#252)
- **drill**: Respect keep-out zones — skip holes inside and route traverse around them (#249)
- **machine**: Selectable console + copy-log button (#244)
- **machine**: Per-line timestamps in the console (#243)
- **machine**: Repeatable work zero via homing (save/restore offset) (#242)
- **drill**: Mark machine work-zero (0,0) and axes on the drill canvas (#232)
- **cnc**: Live drill run — stream program to GRBL with progress and tool-change pauses (#229)
- Drill program preview window (CNC drilling Phase 5) (#225)
- GRBL drill G-code emitter (CNC drilling Phase 4) (#224)
- Derived clamp keep-out zone around tooling holes (#223)
- Collect panel drill holes into a drill plan (CNC drilling Phase 3) (#222)
- CNC machine profile + tool library (CNC drilling Phase 2) (#220)
- GRBL machine connection (CNC drilling Phase 1) (#156)
- Panel keep-out zones — phase 3 (corner resize) (#155)
- **ui**: Show axis coordinate on the rulers while hovering the canvas (#151)
- Panel keep-out zones — phase 2 (nesting + DFM integration) (#150)
- Panel keep-out zones — phase 1 (model + editor) (#149)
- **ui**: Localize native menu via i18n (follows settings language, live) (#148)
- Panel verdict dot on recent cards (catalog-cached, profile-fresh) (#147)

### Bug Fixes

- **panel**: Anchor rotation knob to nearest selected board, not union bbox corner (#539)
- **drill**: Guard Z-headroom at tool-change bind (prevent ALARM:2 on plunge) (#536)
- **ui**: Scope Tailwind source detection to src (stop oxide ingesting garbage candidates) (#535)
- **drill**: Inline-style the probe step-1 card + button borders (oxide bypass) (#531)
- **drill**: Set tool-change card framing via inline style (bypass oxide miscompile) (#530)
- **machine**: Jog edge pull-off 0.01→0.002mm so clicks reach the true travel corner (#529)
- **drill**: Make tool-change card border an explicit warning hsl (was resolving faint) (#527)
- **drill**: Report awaitingToolChange on re-attach via a dedicated phase flag (#526)
- **drill**: Count only machine time in the run timer (exclude tool changes / pauses) (#523)
- **drill**: Run-panel polish — feed scale, drop GRBL readout, await-Z coords, human time, warmer change card (#521)
- **drill**: Label the pre-drill Z-lift as a lift, not a traverse (#516)
- **machine**: Keep click-to-move jogs off the soft-limit edge (0.5mm pull-off) (#512)
- **drill**: Jog both X and Y from the board-on-bed click (machine-frame bounds) (#508)
- **jog**: Back continuous jog off the bounds edge to avoid GRBL error:15 (#491)
- **ui**: Arm last-session persist after restore; drop stray NUL byte (#490)
- **ui**: Matte 3D finish and softer lighting (de-glare board preview) (#488)
- **ui**: Dedupe concurrent GRBL $$ reads (machine busy on double-mount) (#479)
- **drill**: Label pre-drill lift+traverse as traverse, not descent (#477)
- **board3d**: Keep copper lit on tilt via image-based lighting + true copper colour (#475)
- **machine**: Click-to-move on the work field no longer raises Z first (#472)
- **machine**: Keep the connected port label after a webview reload (#468)
- **ui**: Collapsed equipment rail — center toggle, match icon size, drop header divider (#462)
- **drill**: Lift to safe Z before the first traverse of every group (#461)
- **ui**: Equipment list/editor — design-accurate collapsed rail, name in header, delete in toolbar (#460)
- **drill**: Surface limit-switch recovery in the drill window + add a 0.1mm recovery step (#459)
- **ui**: Move console history button to the right of the input (#458)
- **ui**: Equipment sidebar collapse uses chevrons icon per design (#457)
- **panel**: Auto gap yields clean validation (tolerance + fill both fields) (#454)
- **ui**: Equipment settings polish — masonry cards, work-zone labels, drop duplicate header (#452)
- **drill**: Work-zero layout — XY pad left, coordinates centred, tall Z bar right (#435)
- **machine**: Broadcast machine://disconnected on clean disconnect so follower windows update (#431)
- **drill**: Don't park Z in work frame before the first probe binds it (#428)
- **machine**: Compact ConnBar in the console toolbar so it fits one row (#425)
- **drill**: Explain why work-zero bind is disabled; recover from alarm in-place (#424)
- **machine**: Unlock from the drill run-error banner also dismisses it (#421)
- **project**: Drop redundant hover actions from the design card (#418)
- **drill**: Keep canvas tool palettes clear of the rulers (#406)
- **drill**: Show 'traverse' phase at safe-Z between holes, not 'descent' (#403)
- **drill**: Release the ack channel during a tool-change pause so per-tool Z bind can run (#391)
- **machine**: Step jog only moves requested axes (zero-delta axis no longer clamp-dragged) (#389)
- **drill**: Smooth ruler hover + return to plan after binding zero (#362)
- **machine**: Real-RPM spindle scale + sticky override percentages (#358)
- **machine**: Take work-field canvas out of flow so it can't force panel overflow on resize (#332)
- **machine**: Wrap toolbar and lower split breakpoint so resize never clips controls (#330)
- **machine**: Run homing wait off-thread so the overlay can paint (#327)
- **machine**: Write soft-limit settings with ok-ack so they persist (#318)
- **machine**: Stop echoing status-report polls to the console (#317)
- **ui**: Safe-Z retract clears work zero, capped at machine ceiling (#306)
- **ui**: Wrap modal footer buttons so they stay inside the card (#304)
- **ui**: Clamp drill Z touch-off jog to the machine Z range (#303)
- **ui**: Only confirm field move when a safe-Z lift is needed (#291)
- **ui**: Smooth the work-field position and skip redundant safe-Z lift (#290)
- **ui**: Make the machine control panel scroll and stack on narrow widths (#279)
- **drill**: Liveness-based ok-wait so long moves don't trip a false timeout (#241)
- **drill**: Stop spindle before the tool-change pause (#235)
- **cnc**: Grant the drill window event capability (snapshot bridge) (#226)
- **ui**: Inspector window blank on Windows — hyphen label, not colon (#153)

### Other

- Fix live-marker status not matching the drill-run phase (#509)

* fix(drill): unify drill-run phase categorization for the live marker

* fix(drill): align run-header status with the marker for the stopping phase
- Wire drill UI to Rust drill_plan backend, cache GRBL kinematics, drop TS dupes (#499)

* feat(machine): cache GRBL kinematics with dual invalidation and persist

* feat(drill): drill_plan command using backend-cached kinematics

* refactor(drill): wire drill UI to backend drill_plan command, drop TS routing/gcode/estimate dupes

* perf(drill): run drill_plan command off-thread via spawn_blocking
- Port drill routing, G-code & time estimate to Rust core (cuprum-drill) (#497)

* feat(drill): scaffold cuprum-drill crate

* feat(drill): geometry primitives (expand, seg-rect, point-in-rect)

* feat(drill): route/program/estimate types (serde camelCase DTOs)

* feat(drill): keep-out traverse routing (visibility graph + Dijkstra)

* feat(drill): nearest-neighbour ordering + panel-aware route planning

* feat(drill): GRBL drill G-code emitter (byte-parity with TS)

* feat(drill): trapezoidal drill-time estimate from GRBL kinematics

* feat(drill): drill_plan facade (route+program+estimate) + core re-export

* fix(drill): startMachineXY DTO contract (object, explicit rename)
- Keep drill traverse inside the panel via a visibility-graph router (#492) (#496)

* feat(drill): visibility-graph traverse router constrained to the panel

* refactor(drill): route preview traverse via visibility router with panel bounds

* refactor(drill): emit G-code traverse via visibility router with panel bounds

* refactor(drill): drop the legacy avoidZones corner heuristic

* fix(drill): keep drill traverse inside the panel near edge keep-outs (#492)

* fix(drill): use machine-space panel bounds for non-bottom-left datums
- Revert "feat(machine): respect GRBL min spindle speed ($31) as the slider floor (#481)" (#489)

This reverts commit 477a86ca5a9d6e6bd2502d652adc4a60c9c1ff7d.
- GRBL settings editor (1/3): backend to read $$ (#469)

* feat(grbl): parse $N=value settings lines into Line::Setting

* feat(machine): machine_read_settings command to read GRBL $$
- Console command recall and history dropdown (#456)

* feat(ui): console command recall (up/down) and history dropdown

* fix(ui): anchor console success-detection on the command's tx echo

* fix(ui): keep ALARM-tripping commands in console history (valid line)
- Previews and fit counts reflect the pack solver (#451)

* feat(panel): previews and fit counts reflect the solver, not greedy

* fix(panel): stabilize add-design solve debounce and reset on design switch
- Dense panel packing solver in Rust (pack_panel command) (#445)

* feat(nest): cuprum-nest crate — greedy + corner-point branch-and-bound packer

* feat(panel): route real placement through the Rust pack solver (Tauri command)

* fix(panel): renest applies solver result only if no sparser than greedy
- Dense MaxRects panel nesting with per-board rotation (#427)

* feat(panel): dense MaxRects nesting with per-board rotation

* feat(panel): mix-orientation toggle in nesting controls
- Dismiss alarm banner in all windows the moment unlock is pressed (#426)

* fix(machine): dismiss alarm banner in all windows on unlock via global event

* fix(machine): leak-safe unlock listener
- Run history: read-only detail, repeat-run, and pagination (#419)

* feat(operations): paginated run history with read-only detail and repeat-run

* fix(operations): keep load-more under filter; guard repeat-prefill against fetch race
- Prefill drill config from last run; project run-history view (#412)

* feat(operations): prefill drill config from last run; project run-history view

* fix(operations): reset history filter on project change
- Type-agnostic operation-run journal (drill writes it) (#409)

* feat(operations): type-agnostic operation_runs journal; drill writes it

* fix(operations): propagate DB errors in last_params; accurate completed count
- Separate tool-change retract Z + Z feasibility checks for drilling (#405)

* feat(cnc): add + validate tool-change retract Z in the machine profile

* feat(drill): retract to the tool-change Z before bit swaps

* feat(drill): gate the run on Z travel feasibility

* feat(drill): probe approaches safe-Z before G38.2 after a high park

* fix(drill): don't report the redundant Z span reason when a single limit fails
- Move the drilling operation into its own window (#404)

* feat(drill): move the drilling operation into its own window

* refactor(drill): reuse useDrillScreenData in the drill bridge

* fix(drill): close drill window on app quit; harden run-status re-attach

* fix(machine): drop clone-on-copy for Pins in the status broadcast
- Panel editor: rotate cursor when hovering the rotation knob (#402)

* feat(panel): rotate cursor when hovering the rotation knob

* fix(panel): hold the rotate cursor through the whole rotation drag
- Panel editor: restyle the rotation knob as a screen-constant copper ring (#399)

* fix(panel): restyle rotation knob as a screen-constant copper ring

* fix(panel): skip the rotation knob until the viewport is measured
- Drill screen: CNC machine picker + persistent connection status (#388)

* feat(drill): CNC machine picker + persistent connection status in the footer

* fix(drill): guard empty machine name / null port in the connection summary
- Show design composite imagery on the panel preview (#381)

* feat(core): frame composite preview to the board outline bbox

* feat(panel): cache per-design composite preview images

* feat(panel): underlay design composite imagery on the panel preview

* fix(panel): always populate fetched preview image to avoid orphaned in-flight id

* style: cargo fmt + accurate compose_svg doc
- Connect to the machine from the drill screen (ConnBar in footer) (#379)

* feat(drill): connect to the machine from the drill screen (ConnBar in footer)

* refactor(drill): scope shrink-0 to compact ConnBar; keep disconnected hint guard
- Redesign drill hole-cycle progress marker (single-sweep arc + phase pill) (#365)

* feat(drill): collapse phase progress into a single weighted sweep

* feat(drill): resolve drill class by run-order index

* feat(drill): localize hole-cycle phase names

* feat(drill): add single-sweep hole-cycle progress ring

* feat(drill): handoff crosshair + phase/coords pill in machine marker

* feat(drill): wire single-sweep ring + phase pill into the run view

* fix(drill): pulse owns opacity + simplify run-idle phases
- Drill Phase 2: stable hole ids + manual hole selection + drilled state (#346)

* feat(drill): stable plan-based hole ids + selection/sub-plan helpers

* refactor(drill): selectedHoleIds as the single selection source + drilled tracking

* feat(drill): canvas renders all holes, click toggles selection, drilled by stable id

* fix(drill): holeIdsInRunOrder returns null (not empty string) for untagged holes
- Drill Phase 1: free class selection (presets + chips) + persistent work zero (#340)

* refactor(drill): keep work zero across runs; drop pass auto-advance

* feat(drill): free class selection (presets + chips) replaces pass stepper

* refactor(drill): rename DrillRunInspector onPassDone -> onRunDone
- Merge X-Y zero + Z touch-off into one XYZ work-zero card on the shared jog controller (#334)
- Keep machine homed across power-retained reconnects (#328)

* feat(machine): keep homed across power-retained reconnects (no forced re-home)

* fix(machine): never infer homed if alarm was seen since connect (x-unlock guard)
- Drill canvas: fix datum axes + live marker offset (double-applied stage transform) (#315)

* fix(drill): render datum axes + live marker inside fit-group (fix double-applied stage transform)

* fix(drill): seed marker position in layout effect to avoid first-frame flash
- Drill work-zero: confirm GRBL accepted the zero before trusting it (crash fix) + unify G54 (#313)

* fix(drill): confirm GRBL accepted work zero (G54) before trusting it; unify G10 L20 P1

* fix(drill): guard against re-entrant work-zero bind during ack wait
- Drill redesign Phase 4: RUN-mode inspector (progress ring, tool-change, feed override) (#307)

* feat(drill): run-start timestamp + route/hole helpers + stepper done state

* feat(drill): run header ring, tool-change wizard, finish card, feed slider components

* feat(drill): RUN-mode inspector assembly + feed override + finish/next-pass wiring

* feat(drill): split traverse path into drilled (copper) and remaining (dim) on the canvas

* fix(drill): reset run to PLAN on finish-pass; guard feed-override race; surface run error
- Drill redesign Phase 3: PLAN-mode inspector (stepper, preflight, Z touch-off) (#300)

* feat(drill): plan inspector shell + process stepper (run-selection via active pass)

* feat(drill): selected-hole card + preflight summary in plan inspector

* feat(drill): tools-order list with class + nearest-bit override; drop DrillSummary

* feat(drill): Z touch-off card with jog + computable start gate (G10 L20 P1)

* feat(drill): datum grid in inspector + sticky start footer gated by Z; run panel only when active

* fix(drill): invalidate Z touch-off on re-home; recompute unmatched after bit override; clear hole selection on route change; i18n hardcoded units
- Manual CNC safety (2/2): GRBL soft limits + step-jog clamp (#301)

* feat(ui): detect and configure GRBL soft limits

* feat(ui): clamp step jog to the work envelope

* fix(ui): publish maxTravel only once all axes are known
- Manual CNC safety (1/2): machine-frame safe-Z retract and homing gate (#299)

* feat(ui): machine-frame safe-Z retract (G53) with machineSafeZMm field

* feat(ui): track homed state to gate machine-coordinate auto-moves

* fix(ui): enforce homed guard in gotoWorkZero and re-validate field move
- Drill redesign Phase 2: CAD canvas (zoom/pan, rulers, hover, select, toolbar) (#296)

* feat(drill): zoom/pan + adaptive grid on the drill canvas

* feat(drill): rulers + datum-aware numbering + hover readout on drill canvas

* feat(drill): click-to-select holes + tool palette on the drill canvas

* feat(drill): canvas top toolbar — visibility chips + path/diameter toggles

* fix(drill): correct datum-flip ruler numbering; cancel hover rAF on leave; cap diameter label size
- Continuous (hold) jog with realtime jog-cancel (#295)

* feat(machine): jog-cancel realtime command

* feat(ui): continuous (hold) jog mode

* fix(ui): halt continuous jog on mode switch and await cancel before re-jog
- CNC overrides: parse Ov, realtime override commands, overrides card (#294)

* feat(grbl): parse Ov overrides + realtime override bytes

* feat(machine): machine_override command + overrides telemetry

* feat(ui): feed/spindle override card
- Drill redesign Phase 1: inline operation editor (drop separate window) (#292)

* feat(drill): inline drill snapshot source + extract DrillOperationEditor

* feat(drill): operations list + inline drill editor with breadcrumb

* refactor(drill): drop separate drill window + IPC bridge

* chore(drill): drop stale drill-window capability + comments after inlining

* style(drill): cargo fmt src-tauri after window removal
- Redesign the manual CNC control screen (Classic layout, phase 1) (#284)

* feat(ui): add info/field/axis design tokens

* feat(ui): CNC work-area canvas, Z bar and status primitives

* feat(ui): redesigned DRO hero and diagonal jog pad

* feat(ui): spindle ring, quick actions, conn bar, toolbar, console drawer, alarm banner

* feat(ui): assemble classic CNC control layout with console toggle

* feat(ui): collapsible equipment sidebar with icon rail

* chore(ui): retire old machine control widgets

* fix(ui): gate header go-to-zero, guard jog keys and work-field math
- Drill run start: keep-out on first traverse + current-hole progress event (#280)

* fix(drill): emit progress at hole start so the current-hole ring shows

* fix(drill): avoid keep-out on the first traverse from the real start position
- Live port-list refresh + filter out non-machine serial ports (#277)

* feat(machine): live port-list refresh + filter out non-machine ports

* fix(machine): stabilize port refresh callback to avoid stale closure

* docs(machine): fix clippy doc_lazy_continuation in is_machine_port
- Drill window: live depth progress ring on the current hole (#276)

* feat(drill): pure per-hole depth-fraction helpers

* feat(drill): live depth progress ring on the current hole

* fix(drill): self-stopping ease loop; snap ring to 0 on hole change
- Merge live machine control into the equipment section (#275)

* refactor(ui): extract MachineControlPanel from MachinePage

* feat(ui): machine control tab inside the equipment editor

* chore(ui): remove the standalone machine view

* fix(ui): point drill hints to the equipment control tab
- Drill passes: selective run by hole class + plain-Russian class names (#273)

* feat(drill): pure drill-pass presets, class counts, plan filter

* feat(drill): rename class labels to plain Russian, add pass labels

* feat(drill): selection state + filter plan/route/program by class

* feat(drill): pass selector UI + dim unselected holes on canvas and summary

* fix(drill): silence registration-keepout for non-registration passes; drop dead summary dimming; stable dim keys
- Move equipment to the nav rail; drop printers and active radios (#272)

* feat(ui): move equipment registry to the nav rail

* refactor(ui): drop active radios for last-selected machine

* chore(ui): remove the printers placeholder view

* fix(ui): update last-selected machine from live store on add
- Fix drill pause/stop overrunning the current hole (GRBL buffer sync) (#271)

* fix(drill): sync to motion-done per step so pause/stop land on the hole boundary

* fix(drill): skip first idle check in motion sync to dodge stale-Idle race
- Drill pause/stop: show a spinner while the request is in flight (#266)

* feat(drill): pausing/stopping intermediate state with spinner

* fix(drill): make graceful stop idempotent like pause
- Equipment settings section: machine library (CNC + UV) (#265)

* feat(ui): machine builders for the equipment registry

* refactor(ui): make the CNC fields editor machine-scoped

* feat(ui): equipment settings section with machine library

* refactor(ui): clearer next-selection on machine delete
- Drill class classification + manual per-diameter override (manifest) (#264)

* feat(project): drill_class_overrides in panel manifest (schema v4)

* feat(drill): apply per-diameter class override in plan

* feat(drill): bridge intent + shell mutator to persist class override

* feat(drill): per-group class override dropdown in summary

* fix(drill): add class.aria i18n key for class dropdown
- Graceful drill pause/stop at hole boundary + emergency stop (#258)

* feat(drill): graceful boundary pause/stop + emergency stop in the runner

* feat(drill): graceful stop + emergency-stop button in the run panel

* fix(drill): honour stop during idle-wait; emit paused only when actually stopped
- Stop the spindle when a drill run is paused (#253)

* feat(grbl): add SPINDLE_STOP_TOGGLE (0x9E) realtime command

* fix(drill): stop the spindle on pause via 0x9E spindle-stop overlay

* refactor(grbl): re-export SPINDLE_STOP_TOGGLE at crate root for consistency

* fix(drill): make pause idempotent and gate spindle-stop on observed Hold
- Decouple the panel from machine work-area settings (#247)

* refactor(panel): drop machine work-area checks from panel/design DFM

* refactor(panel): remove machine work-area from the panel editor UI

* docs: panel is machine-independent; work-area moved to per-operation

* refactor(panel): drop stale work-area comments
- Drill window: live machine position marker during a run (#236)

* feat(drill): pure helpers for live machine-position marker

* feat(machine): broadcast global machine://status for other windows

* feat(drill): subscribe to machine://status in the drill window

* feat(drill): live machine-position marker on the drill canvas
- Decouple board placement from side: placements span both sides (#228)

* refactor(panel): decouple board placement from side; placements span both sides

* docs(panel): drop layer_ref from PROJECT/GLOSSARY; clean dead bare-side style and test fixtures

### Performance

- **ui**: Reveal design window only once its preview has rendered (#380)
- **ui**: Drop three from boardOutline so it leaves the startup bundle (#374)
- **ui**: Show secondary windows only once content is ready (#373)
- **ui**: Lazy-load Board3D to slim the startup bundle (#371)
- **drill**: Disable perfectDraw on hole circles (kills offscreen buffer for dimmed holes) (#370)
- **rulers**: Drive axis carets imperatively to stop window-wide rAF throttle (#366)
- **drill**: Isolate the holes layer from hover and GRBL-poll re-renders (#350)

### Refactor

- **drill**: Compact horizontal run-progress header (#500)
- **ui**: Extract panel context actions, key handlers, draft shapes (#482)
- **ui**: Extract pure DRC marker/issue/stack logic into lib/ with tests (#476)
- **ui**: Extract shared Konva zoom/pan into useKonvaViewport (#470)
- **panel**: Drop the design-name label now that imagery shows (#385)
- **machine**: Move action buttons into the toolbar (#325)
- **machine**: Drop save/restore work-zero from manual control (#321)
- **panel**: Collapse keep-out zones to a single type (drop kind) (#250)
- **ui**: Drop axis readout labels, keep only the ruler carets (#154)
- **ui**: Axis readout as a light caret + haloed text instead of boxed chips (#152)

### Documentation

- **design**: Drill screen v2 — zero-binding mode, selection-as-visibility, board-on-bed map
- Slim roadmap to a phase narrative; tracker moved to GitHub Project
- **roadmap**: Hover over grid shows the axis value on the ruler
- Record GRBL transport decision (persistent conn, invoke+Channel) in Phase 1
- Add GRBL jog and async-actor follow-ups to drilling backlog
- **roadmap**: Decouple panel from machine work-zone (validate fit in the operation)
- Restructure Phase 2 into CNC drilling workstream
- **roadmap**: Keep-out zones (typed) + derived tooling-hole dead-zone

### CI

- **release**: Push release bump as an admin PAT to satisfy protected master (#537)

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


