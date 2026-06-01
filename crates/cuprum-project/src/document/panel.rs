//! FR4 blank definition (`PanelDoc`): size and panel-space origin in the
//! panel's coordinate system. Stored in `Manifest::panel` (schema v4+);
//! previously lived in a separate `panel.json` container entry (schema ≤ v3).

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

/// Bump when the on-disk shape changes incompatibly.
pub const CURRENT_PANEL_SCHEMA_VERSION: u32 = 1;

/// The FR4 blank definition (size + panel-space origin). Stored in
/// `Manifest::panel` since schema v4; previously a separate `panel.json` entry.
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
