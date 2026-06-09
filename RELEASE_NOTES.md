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

- **release**: Install libudev-dev for the Linux bundle (serialport dep) (#540)
- **release**: Push release bump as an admin PAT to satisfy protected master (#537)

### Chores

- Revert the v0.5.0 release bump to re-cut it cleanly (#542)

