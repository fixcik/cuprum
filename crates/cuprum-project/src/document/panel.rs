//! FR4 blank definition (`PanelDoc`): size, panel-space origin, board instances,
//! and tooling holes. Embedded in `Manifest::panel` (manifest schema v4+;
//! previously a separate `panel.json` entry). `PanelDoc` itself is schema v2
//! (added `instances` + `tooling_holes`).

use serde::{Deserialize, Serialize};

/// Which physical copper layer a board instance sits on. `side` (top/bottom) is
/// derived; the enum is widened to `In1..InN` later for multilayer without a
/// migration.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "PascalCase")]
pub enum LayerRef {
    #[default]
    Top,
    Bottom,
}

/// Purpose of a tooling hole on the panel.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolingHoleRole {
    #[default]
    Registration,
    Flip,
    Unused,
}

/// One copy of a `Design` placed on the panel.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BoardInstance {
    /// Stable id within the panel, e.g. "inst-1".
    pub id: String,
    /// References a `Design.id` in the project library.
    pub design_id: String,
    /// Board origin in panel space (mm).
    pub x_mm: f32,
    pub y_mm: f32,
    /// Rotation in degrees — arbitrary (boards may be round/polygonal).
    pub rotation_deg: f32,
    #[serde(default)]
    pub layer_ref: LayerRef,
}

/// A mechanical pin hole in the panel. Depth is always the full FR4 thickness
/// (`stackup.substrate_thickness_mm`) and is not stored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ToolingHole {
    /// Stable id within the panel, e.g. "th-1".
    pub id: String,
    pub x_mm: f32,
    pub y_mm: f32,
    pub diameter_mm: f32,
    #[serde(default)]
    pub role: ToolingHoleRole,
}

/// Bump when the on-disk shape changes incompatibly.
/// v2: panel carries board instances and tooling holes.
pub const CURRENT_PANEL_SCHEMA_VERSION: u32 = 2;

/// The FR4 blank definition (size + panel-space origin + layout). Embedded in
/// `Manifest::panel` since manifest schema v4; previously a separate `panel.json`
/// entry. Panel doc schema: see `CURRENT_PANEL_SCHEMA_VERSION`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PanelDoc {
    pub schema_version: u32,
    /// Blank width in millimetres.
    pub width_mm: f32,
    /// Blank height in millimetres.
    pub height_mm: f32,
    /// Panel-space origin X (mm). Default 0 = bottom-left corner.
    #[serde(default)]
    pub origin_x_mm: f32,
    /// Panel-space origin Y (mm). Default 0 = bottom-left corner.
    #[serde(default)]
    pub origin_y_mm: f32,
    /// Board instances placed on this panel.
    #[serde(default)]
    pub instances: Vec<BoardInstance>,
    /// Tooling holes drilled into this panel.
    #[serde(default)]
    pub tooling_holes: Vec<ToolingHole>,
}

impl PanelDoc {
    /// A fresh blank at origin (0,0) with the current schema version.
    pub fn new(width_mm: f32, height_mm: f32) -> Self {
        Self {
            schema_version: CURRENT_PANEL_SCHEMA_VERSION,
            width_mm,
            height_mm,
            origin_x_mm: 0.0,
            origin_y_mm: 0.0,
            instances: Vec::new(),
            tooling_holes: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_ref_serializes_pascal_case() {
        assert_eq!(serde_json::to_string(&LayerRef::Top).unwrap(), "\"Top\"");
        assert_eq!(
            serde_json::to_string(&LayerRef::Bottom).unwrap(),
            "\"Bottom\""
        );
        assert_eq!(LayerRef::default(), LayerRef::Top);
    }

    #[test]
    fn role_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ToolingHoleRole::Registration).unwrap(),
            "\"registration\""
        );
        assert_eq!(ToolingHoleRole::default(), ToolingHoleRole::Registration);
    }

    #[test]
    fn board_instance_round_trips() {
        let inst = BoardInstance {
            id: "inst-1".into(),
            design_id: "design-1".into(),
            x_mm: 10.0,
            y_mm: 15.0,
            rotation_deg: 37.5, // arbitrary angle
            layer_ref: LayerRef::Bottom,
        };
        let json = serde_json::to_string(&inst).unwrap();
        assert_eq!(serde_json::from_str::<BoardInstance>(&json).unwrap(), inst);
    }

    #[test]
    fn board_instance_defaults_layer_ref_to_top() {
        let json = r#"{"id":"i","design_id":"d","x_mm":0.0,"y_mm":0.0,"rotation_deg":0.0}"#;
        let inst: BoardInstance = serde_json::from_str(json).unwrap();
        assert_eq!(inst.layer_ref, LayerRef::Top);
    }

    #[test]
    fn tooling_hole_round_trips() {
        let th = ToolingHole {
            id: "th-1".into(),
            x_mm: 5.0,
            y_mm: 5.0,
            diameter_mm: 3.0,
            role: ToolingHoleRole::Flip,
        };
        let json = serde_json::to_string(&th).unwrap();
        assert_eq!(serde_json::from_str::<ToolingHole>(&json).unwrap(), th);
    }

    #[test]
    fn tooling_hole_defaults_role_to_registration() {
        let json = r#"{"id":"t","x_mm":0.0,"y_mm":0.0,"diameter_mm":3.0}"#;
        let th: ToolingHole = serde_json::from_str(json).unwrap();
        assert_eq!(th.role, ToolingHoleRole::Registration);
    }

    #[test]
    fn panel_v1_loads_with_empty_instances() {
        // A v1 PanelDoc has neither `instances` nor `tooling_holes`.
        let json = r#"{"schema_version":1,"width_mm":200.0,"height_mm":100.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert!(p.instances.is_empty());
        assert!(p.tooling_holes.is_empty());
    }

    #[test]
    fn panel_new_is_schema_v2_empty() {
        let p = PanelDoc::new(150.0, 100.0);
        assert_eq!(p.schema_version, CURRENT_PANEL_SCHEMA_VERSION);
        assert_eq!(CURRENT_PANEL_SCHEMA_VERSION, 2);
        assert!(p.instances.is_empty());
        assert!(p.tooling_holes.is_empty());
    }

    #[test]
    fn panel_json_round_trip() {
        let p = PanelDoc::new(200.0, 100.0);
        let json = serde_json::to_string_pretty(&p).unwrap();
        let back: PanelDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
        assert_eq!(back.schema_version, CURRENT_PANEL_SCHEMA_VERSION);
    }

    #[test]
    fn origin_defaults_to_zero() {
        let json = r#"{"schema_version":1,"width_mm":50.0,"height_mm":50.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert_eq!(p.origin_x_mm, 0.0);
        assert_eq!(p.origin_y_mm, 0.0);
    }
}
