// Shared input/output types for isolation milling (serde camelCase DTOs).
// Reuses geometry/CNC/kinematics types from cuprum-drill — do not duplicate.
use serde::{Deserialize, Serialize};

/// One closed cut contour in panel space (mm, Y-down, origin top-left).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPath {
    /// Ordered vertices `[x, y]`. The contour is treated as closed: the cut
    /// returns to the first vertex to seal the loop.
    pub points: Vec<[f64; 2]>,
}

/// Cut parameters. Depth is positive; the bit cuts down to `-cut_depth_mm`.
/// When `depth_per_pass_mm` is set and smaller than `cut_depth_mm`, the contour
/// is cut in multiple stepped-down passes.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillParams {
    pub cut_depth_mm: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth_per_pass_mm: Option<f64>,
    pub feed_xy_mm_min: f64,
    pub plunge_mm_min: f64,
    /// Climb milling when true; conventional (reversed contour walk) when false.
    pub climb: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MillStepKind {
    Preamble,
    SpindleUp,
    Path,
    Postamble,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillStep {
    pub lines: Vec<String>,
    pub kind: MillStepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_index: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillProgram {
    pub gcode: String,
    pub steps: Vec<MillStep>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillEstimate {
    pub motion_sec: f64,
    pub cut_len_mm: f64,
    pub travel_len_mm: f64,
    pub path_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mill_path_serializes_camelcase() {
        let s = serde_json::to_string(&MillPath {
            points: vec![[1.0, 2.0]],
        })
        .unwrap();
        assert_eq!(s, r#"{"points":[[1.0,2.0]]}"#);
    }

    #[test]
    fn mill_params_serializes_camelcase() {
        let s = serde_json::to_string(&MillParams {
            cut_depth_mm: 0.2,
            depth_per_pass_mm: None,
            feed_xy_mm_min: 200.0,
            plunge_mm_min: 60.0,
            climb: true,
        })
        .unwrap();
        // depth_per_pass omitted when None; feedXyMmMin camelCased.
        assert_eq!(
            s,
            r#"{"cutDepthMm":0.2,"feedXyMmMin":200.0,"plungeMmMin":60.0,"climb":true}"#
        );
    }

    #[test]
    fn mill_step_kind_serializes_camel_case() {
        // camelCase keeps the compound variant readable on the TS side
        // (`"spindleUp"`, not `"spindleup"`) — consistent with the DTO structs.
        let s = serde_json::to_string(&MillStepKind::SpindleUp).unwrap();
        assert_eq!(s, r#""spindleUp""#);
        assert_eq!(
            serde_json::to_string(&MillStepKind::Preamble).unwrap(),
            r#""preamble""#
        );
    }
}
