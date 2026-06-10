// High-level mill_plan facade: program + estimate from one input.
use crate::estimate::estimate_mill;
use crate::gcode::{emit_mill_program, MillEmitCtx};
use crate::types::*;
use cuprum_drill::{CncParams, DatumCorner, Kinematics, MachineXY, Rect};

/// One DTO carrying everything the backend needs to plan an isolation-milling
/// run. serde camelCase — the Tauri command's input shape.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPlanInput {
    pub paths: Vec<MillPath>,
    pub datum: DatumCorner,
    pub panel_width_mm: f64,
    pub panel_height_mm: f64,
    pub cnc: CncParams,
    pub params: MillParams,
    pub kinematics: Kinematics,
    pub keep_out_zones: Vec<Rect>,
    // `xy` lowercases to `Xy` under camelCase; the TS field is `startMachineXY`,
    // so rename explicitly. MachineXY (object), not a tuple (array).
    #[serde(rename = "startMachineXY")]
    pub start_machine_xy: Option<MachineXY>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPlanResult {
    pub program: MillProgram,
    pub estimate: MillEstimate,
}

/// Plan an isolation-milling run: G-code program (machine space) and a
/// motion-time estimate, all from one input. Pure.
pub fn mill_plan(input: MillPlanInput) -> MillPlanResult {
    let program = emit_mill_program(
        &input.paths,
        MillEmitCtx {
            panel_width_mm: input.panel_width_mm,
            panel_height_mm: input.panel_height_mm,
            datum: input.datum,
            cnc: input.cnc.clone(),
            params: input.params,
            keep_out_zones: input.keep_out_zones.clone(),
            start_machine_xy: input.start_machine_xy.map(|m| (m.x, m.y)),
        },
    );
    let estimate = estimate_mill(
        &input.paths,
        &input.params,
        &input.kinematics,
        input.cnc.safe_z_mm,
    );
    MillPlanResult { program, estimate }
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn square() -> MillPath {
        MillPath {
            points: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
        }
    }

    #[test]
    fn mill_plan_returns_program_and_estimate() {
        let res = mill_plan(MillPlanInput {
            paths: vec![square()],
            datum: DatumCorner::BottomLeft,
            panel_width_mm: 100.0,
            panel_height_mm: 60.0,
            cnc: CncParams {
                safe_z_mm: 5.0,
                tool_change_z_mm: 20.0,
                spindle_controllable: false,
                spindle_max_rpm: 12000.0,
                prepend_gcode: String::new(),
                append_gcode: String::new(),
            },
            params: MillParams {
                cut_depth_mm: 0.2,
                depth_per_pass_mm: None,
                feed_xy_mm_min: 200.0,
                plunge_mm_min: 60.0,
                climb: true,
            },
            kinematics: Kinematics::default(),
            keep_out_zones: vec![],
            start_machine_xy: None,
        });
        assert!(res.program.gcode.contains("M2"));
        assert!(res.program.gcode.contains("G1 Z-0.200 F60"));
        assert_eq!(res.estimate.path_count, 1);
        assert!(res.estimate.motion_sec > 0.0);
    }

    // The frontend sends `startMachineXY` as an object `{x,y}`; serde must accept
    // it (not the camelCase-mangled `startMachineXy` nor a tuple array).
    #[test]
    fn deserializes_start_machine_xy_object_from_frontend_json() {
        let json = r#"{
            "paths": [],
            "datum": "bottom-left",
            "panelWidthMm": 100.0,
            "panelHeightMm": 60.0,
            "cnc": { "safeZMm": 5.0, "toolChangeZMm": 20.0, "spindleControllable": false,
                     "spindleMaxRpm": 12000.0, "prependGcode": "", "appendGcode": "" },
            "params": { "cutDepthMm": 0.2, "feedXyMmMin": 200.0, "plungeMmMin": 60.0, "climb": true },
            "kinematics": { "maxRateXyMmMin": 1000.0, "maxRateZMmMin": 500.0,
                            "accelXyMmS2": 30.0, "accelZMmS2": 30.0 },
            "keepOutZones": [],
            "startMachineXY": { "x": 90.0, "y": 12.0 }
        }"#;
        let input: MillPlanInput = serde_json::from_str(json).unwrap();
        let m = input
            .start_machine_xy
            .expect("startMachineXY must deserialize");
        assert_eq!((m.x, m.y), (90.0, 12.0));
    }
}
