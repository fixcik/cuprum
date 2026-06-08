// Shared input/output types (serde camelCase DTOs).
use serde::{Deserialize, Serialize};

pub use crate::geom::{Pt, Rect};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DrillClass {
    Registration,
    Pth,
    Npth,
    Mechanical,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanHole {
    pub x_mm: f64,
    pub y_mm: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillGroup {
    pub diameter_mm: f64,
    pub class: DrillClass,
    pub tool_id: Option<String>,
    pub holes: Vec<PlanHole>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PanelDrillPlan {
    pub groups: Vec<DrillGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub diameter_mm: f64,
    pub name: String,
    pub recommended_rpm: f64,
    pub recommended_plunge_mm_min: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DatumCorner {
    BottomLeft,
    BottomRight,
    TopLeft,
    TopRight,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CncParams {
    pub safe_z_mm: f64,
    pub tool_change_z_mm: f64,
    pub spindle_controllable: bool,
    pub spindle_max_rpm: f64,
    pub prepend_gcode: String,
    pub append_gcode: String,
}

/// GRBL motion limits (cached from `$$`). Rates in mm/min ($110-112),
/// accelerations in mm/s² ($120-122).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kinematics {
    pub max_rate_xy_mm_min: f64,
    pub max_rate_z_mm_min: f64,
    pub accel_xy_mm_s2: f64,
    pub accel_z_mm_s2: f64,
}

impl Default for Kinematics {
    /// Stock 3018/GRBL defaults until `$$` is read.
    fn default() -> Self {
        Self {
            max_rate_xy_mm_min: 1000.0,
            max_rate_z_mm_min: 500.0,
            accel_xy_mm_s2: 30.0,
            accel_z_mm_s2: 30.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Machine-space XY point. Mirrors the TS `{ x, y }` object shape (NOT a tuple —
/// a tuple would serialize as a JSON array and break the frontend contract).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct MachineXY {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteGroup {
    pub diameter_mm: f64,
    pub class: DrillClass,
    pub tool_id: Option<String>,
    pub ordered_holes: Vec<PlanHole>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillRoute {
    pub groups: Vec<RouteGroup>,
    pub path_points: Vec<PlanHole>,
    pub total_holes: usize,
    pub tool_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Preamble,
    Toolchange,
    Hole,
    Postamble,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillStep {
    pub lines: Vec<String>,
    pub kind: StepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_for_tool_change: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hole_index: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillProgram {
    pub gcode: String,
    pub steps: Vec<DrillStep>,
    pub skipped_diameters_mm: Vec<f64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillEstimate {
    pub travel_mm: f64,
    pub motion_sec: f64,
    pub tool_changes: u32,
}

/// Default breakthrough (mm) past the bottom of the substrate to ensure clean perforation.
pub const DEFAULT_BREAKTHROUGH_MM: f64 = 0.3;
/// Clearance (mm) used when routing the drill traverse around keep-out zones.
pub const KEEPOUT_TRAVERSE_MARGIN_MM: f64 = 1.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_hole_serializes_camelcase() {
        let s = serde_json::to_string(&PlanHole {
            x_mm: 1.0,
            y_mm: 2.0,
            id: None,
        })
        .unwrap();
        assert_eq!(s, r#"{"xMm":1.0,"yMm":2.0}"#);
    }
}
