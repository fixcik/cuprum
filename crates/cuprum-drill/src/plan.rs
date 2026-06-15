// High-level drill_plan facade: route + program + estimate from one input.
use crate::estimate::estimate_drill;
use crate::gcode::{emit_drill_program, EmitCtx};
use crate::geom::Rect;
use crate::registration::Registration;
use crate::route::plan_drill_route;
use crate::types::*;

/// One DTO carrying everything the backend needs to plan a drill run. serde
/// camelCase — this is the Tauri command's input shape.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillPlanInput {
    pub plan: PanelDrillPlan,
    pub datum: DatumCorner,
    pub panel_width_mm: f64,
    pub panel_height_mm: f64,
    pub tools: Vec<Tool>,
    pub cnc: CncParams,
    pub kinematics: Kinematics,
    pub substrate_thickness_mm: f64,
    pub breakthrough_mm: Option<f64>,
    pub peck_depth_mm: Option<f64>,
    pub keep_out_zones: Vec<Rect>,
    // `xy` lowercases to `Xy` under camelCase; the TS field is `startMachineXY`,
    // so rename explicitly. MachineXY (object), not a tuple (array).
    #[serde(rename = "startMachineXY")]
    pub start_machine_xy: Option<MachineXY>,
    /// Optional fiducial registration. When provided, hole coordinates are corrected
    /// for board placement offset, rotation and scale before G-code emission.
    /// `None` (the default when not sent by the frontend) → identity, no change.
    #[serde(default)]
    pub registration: Option<Registration>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillPlanResult {
    pub route: DrillRoute,
    pub program: DrillProgram,
    pub estimate: DrillEstimate,
}

/// The datum corner expressed in panel space (Y-down, origin top-left) — the
/// ordering cursor's start point for the preview route.
fn datum_corner_panel_point(d: DatumCorner, w: f64, h: f64) -> (f64, f64) {
    let right = matches!(d, DatumCorner::BottomRight | DatumCorner::TopRight);
    let bottom = matches!(d, DatumCorner::BottomLeft | DatumCorner::BottomRight);
    (if right { w } else { 0.0 }, if bottom { h } else { 0.0 })
}

/// Plan a drill run: ordered route (panel space), G-code program (machine space)
/// and a motion-time estimate, all from one input. Pure.
pub fn drill_plan(input: DrillPlanInput) -> DrillPlanResult {
    let start = datum_corner_panel_point(input.datum, input.panel_width_mm, input.panel_height_mm);
    let panel = if input.panel_width_mm > 0.0 && input.panel_height_mm > 0.0 {
        Some(PanelBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: input.panel_width_mm,
            max_y: input.panel_height_mm,
        })
    } else {
        None
    };
    let route = plan_drill_route(&input.plan, start, &input.keep_out_zones, panel);

    let breakthrough = input.breakthrough_mm.unwrap_or(DEFAULT_BREAKTHROUGH_MM);
    let depth = input.substrate_thickness_mm + breakthrough;
    let peck = input.peck_depth_mm.unwrap_or(0.0);

    let program = emit_drill_program(
        &input.plan,
        EmitCtx {
            panel_height_mm: input.panel_height_mm,
            panel_width_mm: input.panel_width_mm,
            datum: input.datum,
            cnc: input.cnc.clone(),
            tools: input.tools.clone(),
            substrate_thickness_mm: input.substrate_thickness_mm,
            breakthrough_mm: input.breakthrough_mm,
            peck_depth_mm: input.peck_depth_mm,
            keep_out_zones: input.keep_out_zones.clone(),
            start_machine_xy: input.start_machine_xy.map(|m| (m.x, m.y)),
            registration: input.registration.clone(),
        },
    );
    let estimate = estimate_drill(
        &route,
        &input.tools,
        &input.kinematics,
        input.cnc.safe_z_mm,
        depth,
        peck,
    );
    DrillPlanResult {
        route,
        program,
        estimate,
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    #[test]
    fn drill_plan_returns_route_program_estimate() {
        let plan = PanelDrillPlan {
            groups: vec![DrillGroup {
                diameter_mm: 1.0,
                class: DrillClass::Registration,
                tool_id: Some("t1".into()),
                holes: vec![
                    PlanHole {
                        x_mm: 0.0,
                        y_mm: 0.0,
                        id: Some("0:0".into()),
                    },
                    PlanHole {
                        x_mm: 10.0,
                        y_mm: 0.0,
                        id: Some("0:1".into()),
                    },
                ],
            }],
        };
        let res = drill_plan(DrillPlanInput {
            plan,
            datum: DatumCorner::BottomLeft,
            panel_width_mm: 100.0,
            panel_height_mm: 60.0,
            tools: vec![Tool {
                id: "t1".into(),
                diameter_mm: 1.0,
                name: "d".into(),
                recommended_rpm: 9000.0,
                recommended_plunge_mm_min: 60.0,
            }],
            cnc: CncParams {
                safe_z_mm: 5.0,
                tool_change_z_mm: 20.0,
                spindle_controllable: false,
                spindle_max_rpm: 9000.0,
                prepend_gcode: String::new(),
                append_gcode: String::new(),
            },
            kinematics: Kinematics::default(),
            substrate_thickness_mm: 1.6,
            breakthrough_mm: None,
            peck_depth_mm: None,
            keep_out_zones: vec![],
            start_machine_xy: None,
            registration: None,
        });
        assert_eq!(res.route.total_holes, 2);
        assert!(res.program.gcode.contains("M2"));
        assert!(res.estimate.motion_sec > 0.0);
        assert_eq!(res.estimate.tool_changes, 1);
    }

    // The frontend sends `startMachineXY` as an object `{x,y}`; serde must accept
    // it (not the camelCase-mangled `startMachineXy` nor a tuple array).
    #[test]
    fn deserializes_start_machine_xy_object_from_frontend_json() {
        let json = r#"{
            "plan": { "groups": [] },
            "datum": "bottom-left",
            "panelWidthMm": 100.0,
            "panelHeightMm": 60.0,
            "tools": [],
            "cnc": { "safeZMm": 5.0, "toolChangeZMm": 20.0, "spindleControllable": false,
                     "spindleMaxRpm": 9000.0, "prependGcode": "", "appendGcode": "" },
            "kinematics": { "maxRateXyMmMin": 1000.0, "maxRateZMmMin": 500.0,
                            "accelXyMmS2": 30.0, "accelZMmS2": 30.0 },
            "substrateThicknessMm": 1.6,
            "keepOutZones": [],
            "startMachineXY": { "x": 90.0, "y": 12.0 }
        }"#;
        let input: DrillPlanInput = serde_json::from_str(json).unwrap();
        let m = input
            .start_machine_xy
            .expect("startMachineXY must deserialize");
        assert_eq!((m.x, m.y), (90.0, 12.0));
    }
}
