// GRBL drill G-code emitter — port of drillGcode.ts.
use crate::geom::{Pt, Rect};
use crate::route::{machine_point, order_nearest, route_avoiding};
use crate::types::*;

/// JS `toFixed(3)` equivalent: round half away from zero at 3 decimals.
/// Plain `format!("{:.3}")` rounds half-to-even → last-digit drift on ".xxx5".
pub fn fmt_mm(x: f64) -> String {
    format!("{:.3}", (x * 1000.0).round() / 1000.0)
}

/// Emit context (mirrors `DrillGcodeCtx` from drillGcode.ts).
pub struct EmitCtx {
    pub panel_height_mm: f64,
    pub panel_width_mm: f64,
    pub datum: DatumCorner,
    pub cnc: CncParams,
    pub tools: Vec<Tool>,
    pub substrate_thickness_mm: f64,
    pub breakthrough_mm: Option<f64>,
    pub peck_depth_mm: Option<f64>,
    pub keep_out_zones: Vec<Rect>,
    /// Actual machine WORK position (mm) when the run starts. Used ONLY as the
    /// origin for the first traverse's keep-out avoidance. Defaults to (0,0) →
    /// byte-identical output when omitted.
    pub start_machine_xy: Option<(f64, f64)>,
}

fn class_order(c: DrillClass) -> u8 {
    match c {
        DrillClass::Registration => 0,
        DrillClass::Pth => 1,
        DrillClass::Npth => 2,
        DrillClass::Mechanical => 3,
    }
}

/// Port of `buildDrillProgram`: produces both the flat lines array (for gcode
/// text) and the structured steps array simultaneously. Byte-parity with TS.
pub fn emit_drill_program(plan: &PanelDrillPlan, ctx: EmitCtx) -> DrillProgram {
    let panel_height_mm = ctx.panel_height_mm;
    let w_mm = ctx.panel_width_mm;
    let datum = ctx.datum;
    let breakthrough = ctx.breakthrough_mm.unwrap_or(DEFAULT_BREAKTHROUGH_MM);
    let peck = ctx.peck_depth_mm.unwrap_or(0.0);
    let safe_z = ctx.cnc.safe_z_mm;
    let tool_change_z = ctx.cnc.tool_change_z_mm;
    let depth = ctx.substrate_thickness_mm + breakthrough; // positive; drill to -depth

    // Pre-compute machine-space keep-out zones using the same machine_point
    // transform used for holes. Map opposite corners, take min/max for a valid
    // AABB regardless of coordinate sign flips.
    let zones_machine: Vec<Rect> = ctx
        .keep_out_zones
        .iter()
        .map(|z| {
            let (x1, y1) = machine_point(z.x, z.y, datum, w_mm, panel_height_mm);
            let (x2, y2) = machine_point(z.x + z.w, z.y + z.h, datum, w_mm, panel_height_mm);
            let min_x = x1.min(x2);
            let min_y = y1.min(y2);
            Rect {
                x: min_x,
                y: min_y,
                w: (x2 - x1).abs(),
                h: (y2 - y1).abs(),
            }
        })
        .collect();

    // Panel rectangle in MACHINE space (None when width unknown → unbounded).
    let panel_machine: Option<PanelBounds> = if w_mm > 0.0 && panel_height_mm > 0.0 {
        let (px1, py1) = machine_point(0.0, 0.0, datum, w_mm, panel_height_mm);
        let (px2, py2) = machine_point(w_mm, panel_height_mm, datum, w_mm, panel_height_mm);
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
    let mut steps: Vec<DrillStep> = vec![];
    let mut skipped: Vec<f64> = vec![];

    let mut groups: Vec<&DrillGroup> = plan.groups.iter().collect();
    groups.sort_by(|a, b| {
        class_order(a.class).cmp(&class_order(b.class)).then(
            a.diameter_mm
                .partial_cmp(&b.diameter_mm)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    // --- Preamble step ---
    let mut preamble_lines: Vec<String> = vec![];
    if !ctx.cnc.prepend_gcode.trim().is_empty() {
        preamble_lines.push(ctx.cnc.prepend_gcode.trim().to_string());
    }
    preamble_lines.push("G21 G90 G94 G17".to_string());
    // NO Z park here (per-tool-Z model: work-Z unbound until the first probe).
    for l in &preamble_lines {
        all_lines.push(l.clone());
    }
    steps.push(DrillStep {
        lines: preamble_lines,
        kind: StepKind::Preamble,
        pause_for_tool_change: None,
        tool_name: None,
        diameter_mm: None,
        hole_index: None,
    });

    // Ordering cursor starts at the datum corner (machine 0,0).
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;
    // Travel cursor for keep-out avoidance starts at the real machine position.
    let (mut travel_x, mut travel_y) = ctx.start_machine_xy.unwrap_or((0.0, 0.0));
    let mut first_group = true;
    let mut hole_counter: usize = 0;

    for g in &groups {
        let tool: Option<&Tool> = g
            .tool_id
            .as_deref()
            .and_then(|id| ctx.tools.iter().find(|t| t.id == id));
        let tool = match tool {
            Some(t) => t,
            None => {
                skipped.push(g.diameter_mm);
                all_lines.push(format!(
                    "(SKIP: no tool for D{} — {} holes)",
                    fmt_mm(g.diameter_mm),
                    g.holes.len()
                ));
                continue;
            }
        };

        // Tool change: stop spindle, retract (except first group), comment, M0.
        let mut tc_lines: Vec<String> = vec![];
        tc_lines.push("M5".to_string());
        all_lines.push("M5".to_string());

        if !first_group {
            tc_lines.push(format!("G0 Z{}", fmt_mm(tool_change_z)));
            all_lines.push(format!("G0 Z{}", fmt_mm(tool_change_z)));
        }
        first_group = false;

        let comment_line = format!(
            "(insert drill D{} — {})",
            fmt_mm(tool.diameter_mm),
            tool.name
        );
        tc_lines.push(comment_line.clone());
        all_lines.push(comment_line);

        // M0 goes into gcode text only, not into the step lines.
        all_lines.push("M0".to_string());

        steps.push(DrillStep {
            lines: tc_lines,
            kind: StepKind::Toolchange,
            pause_for_tool_change: Some(true),
            tool_name: Some(tool.name.clone()),
            diameter_mm: Some(tool.diameter_mm),
            hole_index: None,
        });

        // Spindle-up lines: prefixed onto the FIRST hole step of this group.
        let mut spindle_up_lines: Vec<String> = vec![];
        if ctx.cnc.spindle_controllable {
            spindle_up_lines.push(format!(
                "M3 S{}",
                tool.recommended_rpm.min(ctx.cnc.spindle_max_rpm).round() as i64
            ));
        } else {
            spindle_up_lines.push(format!(
                "(set spindle ~{} rpm)",
                tool.recommended_rpm.round() as i64
            ));
            spindle_up_lines.push("M3".to_string());
        }

        let machine_pts: Vec<(f64, f64)> = g
            .holes
            .iter()
            .map(|h| machine_point(h.x_mm, h.y_mm, datum, w_mm, panel_height_mm))
            .collect();
        let pts_arr: Vec<[f64; 2]> = machine_pts.iter().map(|&(x, y)| [x, y]).collect();
        let order = order_nearest(&pts_arr, cur_x, cur_y);
        let plunge = tool.recommended_plunge_mm_min.round() as i64;

        for (oi, &idx) in order.iter().enumerate() {
            let (mx, my) = machine_pts[idx];
            let mut hole_lines: Vec<String> = vec![];

            // First hole of this group: lift clear, THEN spin up.
            if oi == 0 {
                let lift_line = format!("G0 Z{}", fmt_mm(safe_z));
                hole_lines.push(lift_line.clone());
                all_lines.push(lift_line);
                for sl in &spindle_up_lines {
                    hole_lines.push(sl.clone());
                    all_lines.push(sl.clone());
                }
            }

            // Detour waypoints (XY-only rapids at safe Z) before the hole rapid.
            if !zones_machine.is_empty() {
                let waypoints = route_avoiding(
                    Pt {
                        x: travel_x,
                        y: travel_y,
                    },
                    Pt { x: mx, y: my },
                    &zones_machine,
                    KEEPOUT_TRAVERSE_MARGIN_MM,
                    panel_machine,
                );
                for wp in waypoints {
                    let wp_line = format!("G0 X{} Y{}", fmt_mm(wp.x), fmt_mm(wp.y));
                    hole_lines.push(wp_line.clone());
                    all_lines.push(wp_line);
                }
            }

            let xy_line = format!("G0 X{} Y{}", fmt_mm(mx), fmt_mm(my));
            hole_lines.push(xy_line.clone());
            all_lines.push(xy_line);

            if peck > 0.0 && peck < depth {
                let mut z = 0.0_f64;
                while z < depth - 1e-9 {
                    z = (z + peck).min(depth);
                    let plunge_line = format!("G1 Z{} F{}", fmt_mm(-z), plunge);
                    hole_lines.push(plunge_line.clone());
                    all_lines.push(plunge_line);
                    let retract_line = format!("G0 Z{}", fmt_mm(safe_z));
                    hole_lines.push(retract_line.clone());
                    all_lines.push(retract_line);
                }
            } else {
                let plunge_line = format!("G1 Z{} F{}", fmt_mm(-depth), plunge);
                hole_lines.push(plunge_line.clone());
                all_lines.push(plunge_line);
                let retract_line = format!("G0 Z{}", fmt_mm(safe_z));
                hole_lines.push(retract_line.clone());
                all_lines.push(retract_line);
            }

            steps.push(DrillStep {
                lines: hole_lines,
                kind: StepKind::Hole,
                pause_for_tool_change: None,
                tool_name: None,
                diameter_mm: None,
                hole_index: Some(hole_counter),
            });
            hole_counter += 1;

            cur_x = mx;
            cur_y = my;
            travel_x = mx;
            travel_y = my;
        }
    }

    // --- Postamble step ---
    let mut postamble_lines: Vec<String> = vec![];
    postamble_lines.push("M5".to_string());
    all_lines.push("M5".to_string());
    postamble_lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
    all_lines.push(format!("G0 Z{}", fmt_mm(safe_z)));
    // Return to work zero (the datum corner = G54 origin) at safe-Z so the bit
    // parks at 0,0 — the operator can rerun without re-zeroing. Comes AFTER the Z
    // retract so the XY move can't drag the bit across the board. Routes around
    // keep-out zones just like an inter-hole traverse, so the emitted path matches
    // the preview route's homing leg.
    if !zones_machine.is_empty() {
        let wps = route_avoiding(
            Pt {
                x: travel_x,
                y: travel_y,
            },
            Pt { x: 0.0, y: 0.0 },
            &zones_machine,
            KEEPOUT_TRAVERSE_MARGIN_MM,
            panel_machine,
        );
        for wp in wps {
            let l = format!("G0 X{} Y{}", fmt_mm(wp.x), fmt_mm(wp.y));
            postamble_lines.push(l.clone());
            all_lines.push(l);
        }
    }
    postamble_lines.push("G0 X0.000 Y0.000".to_string());
    all_lines.push("G0 X0.000 Y0.000".to_string());
    if !ctx.cnc.append_gcode.trim().is_empty() {
        postamble_lines.push(ctx.cnc.append_gcode.trim().to_string());
        all_lines.push(ctx.cnc.append_gcode.trim().to_string());
    }
    // M2 goes into gcode text only, not into step lines.
    all_lines.push("M2".to_string());
    steps.push(DrillStep {
        lines: postamble_lines,
        kind: StepKind::Postamble,
        pause_for_tool_change: None,
        tool_name: None,
        diameter_mm: None,
        hole_index: None,
    });

    let gcode = all_lines.join("\n") + "\n";
    DrillProgram {
        gcode,
        steps,
        skipped_diameters_mm: skipped,
    }
}

#[cfg(test)]
mod gcode_tests {
    use super::*;

    fn tool(id: &str, d: f64) -> Tool {
        Tool {
            id: id.into(),
            diameter_mm: d,
            name: format!("Сверло {d}"),
            recommended_rpm: 9000.0,
            recommended_plunge_mm_min: 60.0,
        }
    }
    fn cnc() -> CncParams {
        CncParams {
            safe_z_mm: 5.0,
            tool_change_z_mm: 20.0,
            spindle_controllable: false,
            spindle_max_rpm: 9000.0,
            prepend_gcode: String::new(),
            append_gcode: String::new(),
        }
    }

    #[test]
    fn fmt_mm_matches_to_fixed_3() {
        assert_eq!(fmt_mm(0.0), "0.000");
        assert_eq!(fmt_mm(-1.9), "-1.900");
        assert_eq!(fmt_mm(60.0), "60.000");
        // Half-away-from-zero (toFixed-style), not Rust's half-to-even.
        assert_eq!(fmt_mm(0.0005), "0.001");
        assert_eq!(fmt_mm(2.0005), "2.001");
        // Same rounding direction on the negative side (toFixed is symmetric).
        assert_eq!(fmt_mm(-0.0005), "-0.001");
        assert_eq!(fmt_mm(-2.0005), "-2.001");
    }

    #[test]
    fn emits_expected_single_group_program() {
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![
                    PlanHole {
                        x_mm: 0.0,
                        y_mm: 0.0,
                        id: None,
                    },
                    PlanHole {
                        x_mm: 10.0,
                        y_mm: 0.0,
                        id: None,
                    },
                ],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                tools: vec![tool("t1", 1.0)],
                substrate_thickness_mm: 1.6,
                breakthrough_mm: None,
                peck_depth_mm: None,
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        let expected = "\
G21 G90 G94 G17
M5
(insert drill D1.000 — Сверло 1)
M0
G0 Z5.000
(set spindle ~9000 rpm)
M3
G0 X0.000 Y60.000
G1 Z-1.900 F60
G0 Z5.000
G0 X10.000 Y60.000
G1 Z-1.900 F60
G0 Z5.000
M5
G0 Z5.000
G0 X0.000 Y0.000
M2
";
        assert_eq!(prog.gcode, expected);
        // preamble + toolchange + 2×hole + postamble = 5 steps.
        assert_eq!(prog.steps.len(), 5);
        // M0 / M2 are in the gcode text but NOT in any step.lines.
        for s in &prog.steps {
            assert!(!s.lines.iter().any(|l| l == "M0" || l == "M2"));
        }
        // hole steps carry sequential hole_index.
        let holes: Vec<&DrillStep> = prog
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Hole)
            .collect();
        assert_eq!(holes.len(), 2);
        assert_eq!(holes[0].hole_index, Some(0));
        assert_eq!(holes[1].hole_index, Some(1));
        // Postamble parks at work zero (0,0) on safe-Z, after the Z retract.
        let post = prog
            .steps
            .iter()
            .find(|s| s.kind == StepKind::Postamble)
            .unwrap();
        let zi = post.lines.iter().position(|l| l == "G0 Z5.000").unwrap();
        let xi = post
            .lines
            .iter()
            .position(|l| l == "G0 X0.000 Y0.000")
            .unwrap();
        assert!(zi < xi, "XY return must come after the Z retract");
    }

    #[test]
    fn skips_group_without_tool() {
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 0.5,
                class: DrillClass::Pth,
                tool_id: None,
                holes: vec![PlanHole {
                    x_mm: 1.0,
                    y_mm: 2.0,
                    id: None,
                }],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                tools: vec![],
                substrate_thickness_mm: 1.6,
                breakthrough_mm: None,
                peck_depth_mm: None,
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        assert_eq!(prog.skipped_diameters_mm, vec![0.5]);
        assert!(prog.gcode.contains("(SKIP: no tool for D0.500 — 1 holes)"));
        // No toolchange / hole steps emitted; only preamble + postamble.
        assert_eq!(prog.steps.len(), 2);
    }

    #[test]
    fn peck_emits_repeated_plunge_retract() {
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![PlanHole {
                    x_mm: 0.0,
                    y_mm: 0.0,
                    id: None,
                }],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                tools: vec![tool("t1", 1.0)],
                substrate_thickness_mm: 1.6, // depth = 1.9
                breakthrough_mm: None,
                peck_depth_mm: Some(1.0), // pecks: -1.0 then -1.9
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // Two peck cycles: G1 Z-1.000 and G1 Z-1.900.
        assert!(prog.gcode.contains("G1 Z-1.000 F60"));
        assert!(prog.gcode.contains("G1 Z-1.900 F60"));
        let plunges = prog.gcode.matches("G1 Z").count();
        assert_eq!(plunges, 2);
    }

    #[test]
    fn keepout_inserts_detour_waypoint() {
        // Two holes with a zone between them in machine space → detour waypoint.
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Pth,
                tool_id: Some("t1".into()),
                holes: vec![
                    PlanHole {
                        x_mm: 10.0,
                        y_mm: 30.0,
                        id: None,
                    },
                    PlanHole {
                        x_mm: 90.0,
                        y_mm: 30.0,
                        id: None,
                    },
                ],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                tools: vec![tool("t1", 1.0)],
                substrate_thickness_mm: 1.6,
                breakthrough_mm: None,
                peck_depth_mm: None,
                keep_out_zones: vec![Rect {
                    x: 40.0,
                    y: 0.0,
                    w: 10.0,
                    h: 40.0,
                }],
                start_machine_xy: None,
            },
        );
        // More than the 2 hole rapids → a detour waypoint G0 X was inserted.
        let xy_rapids = prog.gcode.matches("G0 X").count();
        assert!(
            xy_rapids > 2,
            "expected detour waypoint, got {xy_rapids} G0 X lines"
        );
    }

    #[test]
    fn homing_return_routes_around_keepout() {
        // One hole far from the datum, a zone straddling the straight homing line
        // (but not spanning the full height, so a detour exists) → the postamble
        // homing move to 0,0 detours around it (a G0 X waypoint precedes the final
        // `G0 X0.000 Y0.000`).
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Pth,
                tool_id: Some("t1".into()),
                holes: vec![PlanHole {
                    x_mm: 90.0,
                    y_mm: 50.0,
                    id: None,
                }],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomLeft,
                cnc: cnc(),
                tools: vec![tool("t1", 1.0)],
                substrate_thickness_mm: 1.6,
                breakthrough_mm: None,
                peck_depth_mm: None,
                keep_out_zones: vec![Rect {
                    x: 40.0,
                    y: 45.0,
                    w: 10.0,
                    h: 15.0,
                }],
                start_machine_xy: None,
            },
        );
        let post = prog
            .steps
            .iter()
            .find(|s| s.kind == StepKind::Postamble)
            .unwrap();
        let xi = post
            .lines
            .iter()
            .position(|l| l == "G0 X0.000 Y0.000")
            .unwrap();
        let has_detour = post.lines[..xi]
            .iter()
            .any(|l| l.starts_with("G0 X") && l != "G0 X0.000 Y0.000");
        assert!(
            has_detour,
            "expected a homing detour around keep-out, postamble: {:?}",
            post.lines
        );
    }

    #[test]
    fn negative_origin_datum_flips_x() {
        // bottom-right datum → X mapped into the negative quadrant.
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![PlanHole {
                    x_mm: 0.0,
                    y_mm: 0.0,
                    id: None,
                }],
            }],
        };
        let prog = emit_drill_program(
            &plan,
            EmitCtx {
                panel_height_mm: 60.0,
                panel_width_mm: 100.0,
                datum: DatumCorner::BottomRight,
                cnc: cnc(),
                tools: vec![tool("t1", 1.0)],
                substrate_thickness_mm: 1.6,
                breakthrough_mm: None,
                peck_depth_mm: None,
                keep_out_zones: vec![],
                start_machine_xy: None,
            },
        );
        // x=0 with bottom-right (w=100) → -100.000; y=0 → 60.000.
        assert!(prog.gcode.contains("G0 X-100.000 Y60.000"));
    }
}
