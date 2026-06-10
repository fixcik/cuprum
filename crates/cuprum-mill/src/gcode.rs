// GRBL isolation-milling G-code emitter. Mirrors cuprum-drill's gcode.rs but
// walks closed contours instead of point drills.
use crate::types::*;
use cuprum_drill::{
    fmt_mm, machine_point, order_nearest, route_avoiding, CncParams, DatumCorner, PanelBounds, Pt,
    Rect, KEEPOUT_TRAVERSE_MARGIN_MM,
};

/// Emit context for milling. `start_machine_xy` is the real machine WORK
/// position (mm) at run start; used only as the origin for the first traverse's
/// keep-out avoidance. Defaults to (0,0).
pub struct MillEmitCtx {
    pub panel_width_mm: f64,
    pub panel_height_mm: f64,
    pub datum: DatumCorner,
    pub cnc: CncParams,
    pub params: MillParams,
    pub keep_out_zones: Vec<Rect>,
    pub start_machine_xy: Option<(f64, f64)>,
}

/// Map a panel-space keep-out rect into machine space (corner-flip safe AABB),
/// same transform cuprum-drill uses.
fn zone_to_machine(z: &Rect, datum: DatumCorner, w: f64, h: f64) -> Rect {
    let (x1, y1) = machine_point(z.x, z.y, datum, w, h);
    let (x2, y2) = machine_point(z.x + z.w, z.y + z.h, datum, w, h);
    Rect {
        x: x1.min(x2),
        y: y1.min(y2),
        w: (x2 - x1).abs(),
        h: (y2 - y1).abs(),
    }
}

/// Walk a contour's vertices in cut order. `reversed` flips the direction.
/// The contour is closed: the first vertex is appended at the end so the loop
/// seals. Returns machine-space vertices in emission order (start vertex first).
fn contour_walk(machine_pts: &[(f64, f64)], reversed: bool) -> Vec<(f64, f64)> {
    if machine_pts.is_empty() {
        return vec![];
    }
    let mut pts: Vec<(f64, f64)> = if reversed {
        // Keep the same start vertex (index 0), reverse the remaining order.
        // [0, n-1, n-2, ..., 1] so the walk leaves and returns to the start.
        let mut v = vec![machine_pts[0]];
        v.extend(machine_pts[1..].iter().rev().copied());
        v
    } else {
        machine_pts.to_vec()
    };
    // Close the loop back to the start vertex.
    pts.push(pts[0]);
    pts
}

/// Emit a full milling program: preamble, single spindle-up, one Path step per
/// contour (travel + plunge + contour walk, multi-depth aware), postamble.
pub fn emit_mill_program(paths: &[MillPath], ctx: MillEmitCtx) -> MillProgram {
    let w_mm = ctx.panel_width_mm;
    let h_mm = ctx.panel_height_mm;
    let datum = ctx.datum;
    let safe_z = ctx.cnc.safe_z_mm;
    let cut_depth = ctx.params.cut_depth_mm;
    let feed_xy = ctx.params.feed_xy_mm_min.round() as i64;
    let plunge = ctx.params.plunge_mm_min.round() as i64;

    // Machine-space keep-out zones + panel rect (None when width unknown).
    let zones_machine: Vec<Rect> = ctx
        .keep_out_zones
        .iter()
        .map(|z| zone_to_machine(z, datum, w_mm, h_mm))
        .collect();
    let panel_machine: Option<PanelBounds> = if w_mm > 0.0 && h_mm > 0.0 {
        let (px1, py1) = machine_point(0.0, 0.0, datum, w_mm, h_mm);
        let (px2, py2) = machine_point(w_mm, h_mm, datum, w_mm, h_mm);
        Some(PanelBounds {
            min_x: px1.min(px2),
            min_y: py1.min(py2),
            max_x: px1.max(px2),
            max_y: py1.max(py2),
        })
    } else {
        None
    };

    let mut all_lines: Vec<String> = vec![];
    let mut steps: Vec<MillStep> = vec![];
    // Final XY position after the last contour — origin of the homing traverse.
    let mut last_travel: Option<(f64, f64)> = None;

    // --- Preamble ---
    let mut preamble_lines: Vec<String> = vec![];
    if !ctx.cnc.prepend_gcode.trim().is_empty() {
        preamble_lines.push(ctx.cnc.prepend_gcode.trim().to_string());
    }
    preamble_lines.push("G21 G90 G94 G17".to_string());
    // NO Z park (per-tool-Z model; work-Z unbound until first probe).
    for l in &preamble_lines {
        all_lines.push(l.clone());
    }
    steps.push(MillStep {
        lines: preamble_lines,
        kind: MillStepKind::Preamble,
        path_index: None,
    });

    // Precompute machine-space vertices for every contour (skip empties).
    let machine_paths: Vec<Vec<(f64, f64)>> = paths
        .iter()
        .map(|p| {
            p.points
                .iter()
                .map(|v| machine_point(v[0], v[1], datum, w_mm, h_mm))
                .collect()
        })
        .collect();
    // Indices of non-empty paths, ordered by nearest start vertex from 0,0.
    let nonempty: Vec<usize> = (0..machine_paths.len())
        .filter(|&i| !machine_paths[i].is_empty())
        .collect();

    if !nonempty.is_empty() {
        // --- Spindle-up (once, before the first path) ---
        let rpm = ctx.cnc.spindle_max_rpm;
        let mut spindle_lines: Vec<String> = vec![];
        if ctx.cnc.spindle_controllable {
            spindle_lines.push(format!("M3 S{}", rpm.round() as i64));
        } else {
            spindle_lines.push(format!("(set spindle ~{} rpm)", rpm.round() as i64));
            spindle_lines.push("M3".to_string());
        }
        for l in &spindle_lines {
            all_lines.push(l.clone());
        }
        steps.push(MillStep {
            lines: spindle_lines,
            kind: MillStepKind::SpindleUp,
            path_index: None,
        });

        // Order paths by nearest start vertex (first vertex) from datum 0,0.
        let starts: Vec<[f64; 2]> = nonempty
            .iter()
            .map(|&i| {
                let (x, y) = machine_paths[i][0];
                [x, y]
            })
            .collect();
        let order = order_nearest(&starts, 0.0, 0.0);

        // Travel cursor for keep-out avoidance starts at the real machine pos.
        let (mut travel_x, mut travel_y) = ctx.start_machine_xy.unwrap_or((0.0, 0.0));
        let mut first_path = true;

        for &oi in &order {
            let path_idx = nonempty[oi];
            let machine_pts = &machine_paths[path_idx];
            let (start_x, start_y) = machine_pts[0];
            let mut lines: Vec<String> = vec![];

            // Lift to safe-Z before the very first travel.
            if first_path {
                lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
                first_path = false;
            }

            // Detour waypoints (XY rapids at safe-Z) before the start rapid.
            if !zones_machine.is_empty() {
                let wps = route_avoiding(
                    Pt {
                        x: travel_x,
                        y: travel_y,
                    },
                    Pt {
                        x: start_x,
                        y: start_y,
                    },
                    &zones_machine,
                    KEEPOUT_TRAVERSE_MARGIN_MM,
                    panel_machine,
                );
                for wp in wps {
                    lines.push(format!("G0 X{} Y{}", fmt_mm(wp.x), fmt_mm(wp.y)));
                }
            }
            lines.push(format!("G0 X{} Y{}", fmt_mm(start_x), fmt_mm(start_y)));

            // Cut. Multi-depth when depth_per_pass is set and in range.
            let dpp = ctx.params.depth_per_pass_mm;
            let multi = matches!(dpp, Some(d) if d > 0.0 && d < cut_depth);
            if multi {
                let dpp = dpp.unwrap();
                let mut depth = 0.0_f64;
                let mut pass = 0usize;
                while depth < cut_depth - 1e-9 {
                    depth = (depth + dpp).min(cut_depth);
                    // Plunge to this pass's depth (no retract between passes).
                    lines.push(format!("G1 Z{} F{}", fmt_mm(-depth), plunge));
                    // Alternate contour direction each pass (FlatCAM-style):
                    // pass 0 starts in the climb direction; conventional flips it.
                    let reversed = (pass % 2 == 1) ^ (!ctx.params.climb);
                    for (x, y) in contour_walk(machine_pts, reversed) {
                        lines.push(format!("G1 X{} Y{} F{}", fmt_mm(x), fmt_mm(y), feed_xy));
                    }
                    pass += 1;
                }
                lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
            } else {
                lines.push(format!("G1 Z{} F{}", fmt_mm(-cut_depth), plunge));
                for (x, y) in contour_walk(machine_pts, !ctx.params.climb) {
                    lines.push(format!("G1 X{} Y{} F{}", fmt_mm(x), fmt_mm(y), feed_xy));
                }
                lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
            }

            for l in &lines {
                all_lines.push(l.clone());
            }
            steps.push(MillStep {
                lines,
                kind: MillStepKind::Path,
                path_index: Some(path_idx),
            });

            // Cursor ends at the contour's start vertex (loop sealed there).
            travel_x = start_x;
            travel_y = start_y;
            last_travel = Some((start_x, start_y));
        }
    }

    // --- Postamble ---
    let mut postamble_lines: Vec<String> = vec![];
    postamble_lines.push("M5".to_string());
    postamble_lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
    // Return to work zero (datum corner = G54 origin) at safe-Z, routing around
    // keep-out zones like any traverse.
    if let (false, Some((lx, ly))) = (zones_machine.is_empty(), last_travel) {
        let wps = route_avoiding(
            Pt { x: lx, y: ly },
            Pt { x: 0.0, y: 0.0 },
            &zones_machine,
            KEEPOUT_TRAVERSE_MARGIN_MM,
            panel_machine,
        );
        for wp in wps {
            postamble_lines.push(format!("G0 X{} Y{}", fmt_mm(wp.x), fmt_mm(wp.y)));
        }
    }
    postamble_lines.push("G0 X0.000 Y0.000".to_string());
    if !ctx.cnc.append_gcode.trim().is_empty() {
        postamble_lines.push(ctx.cnc.append_gcode.trim().to_string());
    }
    for l in &postamble_lines {
        all_lines.push(l.clone());
    }
    // M2 goes into the gcode text only, not into step lines.
    all_lines.push("M2".to_string());
    steps.push(MillStep {
        lines: postamble_lines,
        kind: MillStepKind::Postamble,
        path_index: None,
    });

    let gcode = all_lines.join("\n") + "\n";
    MillProgram { gcode, steps }
}

#[cfg(test)]
mod gcode_tests {
    use super::*;

    fn cnc() -> CncParams {
        CncParams {
            safe_z_mm: 5.0,
            tool_change_z_mm: 20.0,
            spindle_controllable: false,
            spindle_max_rpm: 12000.0,
            prepend_gcode: String::new(),
            append_gcode: String::new(),
        }
    }

    fn params() -> MillParams {
        MillParams {
            cut_depth_mm: 0.2,
            depth_per_pass_mm: None,
            feed_xy_mm_min: 200.0,
            plunge_mm_min: 60.0,
            climb: true,
        }
    }

    // A unit square contour (4 vertices, CCW in panel space).
    fn square() -> MillPath {
        MillPath {
            points: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
        }
    }

    #[test]
    fn emits_preamble_spindle_single_square() {
        let prog = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // Panel y-flip: (x, 60 - y). Square CCW, climb (forward walk).
        let expected = "\
G21 G90 G94 G17
(set spindle ~12000 rpm)
M3
G0 Z5.000
G0 X0.000 Y60.000
G1 Z-0.200 F60
G1 X0.000 Y60.000 F200
G1 X10.000 Y60.000 F200
G1 X10.000 Y50.000 F200
G1 X0.000 Y50.000 F200
G1 X0.000 Y60.000 F200
G0 Z5.000
M5
G0 Z5.000
G0 X0.000 Y0.000
M2
";
        assert_eq!(prog.gcode, expected);
        // preamble + spindle + path + postamble = 4 steps.
        assert_eq!(prog.steps.len(), 4);
        assert_eq!(prog.steps[0].kind, MillStepKind::Preamble);
        assert_eq!(prog.steps[1].kind, MillStepKind::SpindleUp);
        assert_eq!(prog.steps[2].kind, MillStepKind::Path);
        assert_eq!(prog.steps[2].path_index, Some(0));
        assert_eq!(prog.steps[3].kind, MillStepKind::Postamble);
        // M2 not in any step.
        for s in &prog.steps {
            assert!(!s.lines.iter().any(|l| l == "M2"));
        }
    }

    #[test]
    fn empty_paths_emit_only_preamble_postamble() {
        let prog = emit_mill_program(
            &[],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // No spindle-up, no path steps.
        assert_eq!(prog.steps.len(), 2);
        assert_eq!(prog.steps[0].kind, MillStepKind::Preamble);
        assert_eq!(prog.steps[1].kind, MillStepKind::Postamble);
        assert!(!prog.gcode.contains("M3"));
        // No cut moves (the "G1" in the preamble's "G94 G17" doesn't count).
        assert!(!prog.gcode.contains("G1 "));
    }

    #[test]
    fn empty_contour_path_skipped() {
        // A path with no points is ignored (no spindle-up if it's the only one).
        let prog = emit_mill_program(
            &[MillPath { points: vec![] }],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        assert_eq!(prog.steps.len(), 2);
        assert!(!prog.gcode.contains("M3"));
    }

    #[test]
    fn multi_depth_emits_n_passes_with_reversal() {
        // cut 0.6, dpp 0.2 → 3 passes at -0.2, -0.4, -0.6.
        let mut p = params();
        p.cut_depth_mm = 0.6;
        p.depth_per_pass_mm = Some(0.2);
        let prog = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: p,
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // Three plunges, one per pass.
        assert!(prog.gcode.contains("G1 Z-0.200 F60"));
        assert!(prog.gcode.contains("G1 Z-0.400 F60"));
        assert!(prog.gcode.contains("G1 Z-0.600 F60"));
        let plunges = prog.gcode.matches("G1 Z").count();
        assert_eq!(plunges, 3);
        // No retract BETWEEN passes: the bit stays down across all 3 plunges and
        // lifts exactly once at the end. In the path step the only "G0 Z" that
        // follows a "G1 Z" plunge is the single final retract.
        let path = prog
            .steps
            .iter()
            .find(|s| s.kind == MillStepKind::Path)
            .unwrap();
        let last_plunge = path
            .lines
            .iter()
            .rposition(|l| l.starts_with("G1 Z"))
            .unwrap();
        let retracts_after_last_plunge = path.lines[last_plunge..]
            .iter()
            .filter(|l| l.starts_with("G0 Z"))
            .count();
        assert_eq!(retracts_after_last_plunge, 1);
        // And no "G0 Z" retract sits between the first and last plunge.
        let first_plunge = path
            .lines
            .iter()
            .position(|l| l.starts_with("G1 Z"))
            .unwrap();
        let mid_retracts = path.lines[first_plunge..last_plunge]
            .iter()
            .filter(|l| l.starts_with("G0 Z"))
            .count();
        assert_eq!(mid_retracts, 0);
        // Pass direction alternates: pass 0 forward (climb), pass 1 reversed.
        // Every pass starts at the SAME start vertex (X0 Y60); the SECOND vertex
        // reveals the direction — forward → X10 Y60, reversed → X0 Y50.
        let cut_moves: Vec<&String> = path
            .lines
            .iter()
            .filter(|l| l.starts_with("G1 X"))
            .collect();
        // Pass 0 (forward): moves[0]=start, moves[1]=X10 Y60.
        assert_eq!(cut_moves[1], "G1 X10.000 Y60.000 F200");
        // Pass 1 (reversed): 5 cut moves per pass; pass 1 starts at index 5.
        assert_eq!(cut_moves[5], "G1 X0.000 Y60.000 F200"); // same start
        assert_eq!(cut_moves[6], "G1 X0.000 Y50.000 F200"); // reversed 2nd vertex
                                                            // Pass 2 (forward again): index 10.
        assert_eq!(cut_moves[11], "G1 X10.000 Y60.000 F200");
    }

    #[test]
    fn climb_vs_conventional_reverses_walk() {
        // Climb: forward walk → second vertex X10 Y60. Conventional: reversed →
        // second vertex X0 Y50 (last panel vertex flipped).
        let prog_climb = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        let mut conv = params();
        conv.climb = false;
        let prog_conv = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: conv,
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        let path_climb = prog_climb
            .steps
            .iter()
            .find(|s| s.kind == MillStepKind::Path)
            .unwrap();
        let path_conv = prog_conv
            .steps
            .iter()
            .find(|s| s.kind == MillStepKind::Path)
            .unwrap();
        // First contour move after the plunge differs in the two modes.
        let climb_moves: Vec<&String> = path_climb
            .lines
            .iter()
            .filter(|l| l.starts_with("G1 X"))
            .collect();
        let conv_moves: Vec<&String> = path_conv
            .lines
            .iter()
            .filter(|l| l.starts_with("G1 X"))
            .collect();
        // Both start at the same start vertex.
        assert_eq!(climb_moves[0], "G1 X0.000 Y60.000 F200");
        assert_eq!(conv_moves[0], "G1 X0.000 Y60.000 F200");
        // Second vertex differs: climb forward vs conventional reversed.
        assert_eq!(climb_moves[1], "G1 X10.000 Y60.000 F200");
        assert_eq!(conv_moves[1], "G1 X0.000 Y50.000 F200");
    }

    #[test]
    fn bottom_right_datum_flips_x_negative() {
        let prog = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomRight,
                cnc: cnc(),
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // x=0 with bottom-right (w=100) → -100; y=0 → 60.
        assert!(prog.gcode.contains("G0 X-100.000 Y60.000"));
    }

    #[test]
    fn spindle_controllable_emits_m3_s() {
        let mut c = cnc();
        c.spindle_controllable = true;
        let prog = emit_mill_program(
            &[square()],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: c,
                params: params(),
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        assert!(prog.gcode.contains("M3 S12000"));
        assert!(!prog.gcode.contains("(set spindle"));
    }

    #[test]
    fn keepout_inserts_detour_waypoint() {
        // Two paths separated by a zone between them → detour waypoint.
        let left = MillPath {
            points: vec![[5.0, 25.0], [15.0, 25.0], [15.0, 35.0], [5.0, 35.0]],
        };
        let right = MillPath {
            points: vec![[85.0, 25.0], [95.0, 25.0], [95.0, 35.0], [85.0, 35.0]],
        };
        let prog = emit_mill_program(
            &[left, right],
            MillEmitCtx {
                panel_width_mm: 100.0,
                panel_height_mm: 60.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                params: params(),
                // Partial-height zone (leaves a gap at the top) so a detour path
                // exists — a full-height zone would split the panel and force the
                // straight-line fallback (no waypoints).
                keep_out_zones: vec![Rect {
                    x: 40.0,
                    y: 0.0,
                    w: 10.0,
                    h: 40.0,
                }],
                start_machine_xy: None,
            },
        );
        // The straight inter-path travel is blocked, so route_avoiding inserts at
        // least one extra travel waypoint. With 2 contours we'd have 2 start
        // rapids + final home; a detour adds more.
        let travel_rapids = prog.gcode.matches("G0 X").count();
        assert!(
            travel_rapids > 3,
            "expected detour waypoint, got {travel_rapids} G0 X lines"
        );
    }
}
