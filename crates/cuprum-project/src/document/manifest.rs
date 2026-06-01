//! Project manifest — the `manifest.json` inside a `.cuprum` container.

use crate::document::panel::PanelDoc;
use crate::layer::LayerType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Bump when the on-disk shape changes incompatibly. v2: gerbers carry a layer
/// type. v3: `imports` renamed to `designs`. v4: the FR4 blank (`PanelDoc`) moved
/// from a separate `panel.json` entry into this manifest's `panel` field.
/// v5: dead `placements` removed (replaced by `panel.instances`).
pub const CURRENT_SCHEMA_VERSION: u32 = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Manifest {
    pub schema_version: u32,
    pub name: String,
    /// User-facing project notes shown on the project page.
    #[serde(default)]
    pub description: String,
    /// Designs in the project: one imported Gerber package (board) per source ZIP.
    #[serde(default)]
    pub designs: Vec<Design>,
    /// Exposure settings — filled when the editor is wired in. Optional now.
    #[serde(default)]
    pub exposure: Option<Exposure>,
    /// Optional per-layer-type colour overrides (hex like "#b87333"); empty = use
    /// the UI's default palette. Visibility is UI-only and not persisted.
    #[serde(default)]
    pub layer_colors: BTreeMap<LayerType, String>,
    /// FR4 stackup of the Panel; `None` until the panel blank is configured.
    #[serde(default)]
    pub stackup: Option<Stackup>,
    /// The FR4 blank (size + panel-space origin); `None` until configured.
    /// Migrated from the legacy `panel.json` container entry (schema v4).
    #[serde(default)]
    pub panel: Option<PanelDoc>,
}

impl Manifest {
    /// A fresh, empty manifest with the current schema version.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            name: name.into(),
            description: String::new(),
            designs: Vec::new(),
            exposure: None,
            layer_colors: BTreeMap::new(),
            stackup: None,
            panel: None,
        }
    }
}

/// A Design: one imported Gerber package (board) inside the container.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Design {
    /// Stable id within the container, e.g. "design-1".
    pub id: String,
    /// Original ZIP file name (for display).
    pub source_name: String,
    /// Gerber files in this design, with their classified layer type.
    pub gerbers: Vec<GerberFile>,
}

/// One gerber file inside the container plus its layer classification.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GerberFile {
    /// Relative path inside the container, e.g. "gerbers/design-1/top.gbr".
    pub path: String,
    #[serde(default)]
    pub layer_type: LayerType,
}

/// The FR4 stackup of the project's Panel — depends on the physical blank.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Stackup {
    /// Copper weight in ounces (0.5 / 1 / 2).
    pub copper_weight_oz: f32,
    /// FR4 substrate thickness in millimetres.
    pub substrate_thickness_mm: f32,
    /// Whether the blank is copper-clad on both sides (vs single-sided).
    #[serde(default)]
    pub double_sided: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Exposure {
    pub mirror: bool,
    pub invert: bool,
    pub exposure_s: f32,
    pub pwm: u16,
}

#[cfg(test)]
mod manifest_panel_tests {
    use super::*;
    use crate::document::panel::PanelDoc;

    #[test]
    fn manifest_round_trips_with_panel() {
        let mut m = Manifest::new("demo");
        m.panel = Some(PanelDoc::new(150.0, 100.0));
        let json = serde_json::to_string_pretty(&m).unwrap();
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
        assert_eq!(back.panel.unwrap().width_mm, 150.0);
    }

    #[test]
    fn panel_defaults_to_none_when_absent() {
        // A manifest written before the panel field existed (no `panel` key).
        let json = r#"{"schema_version":3,"name":"x","designs":[]}"#;
        let m = crate::document::migrate::manifest_from_slice(json.as_bytes()).unwrap();
        assert!(m.panel.is_none());
        // v3 → current: the version bump must happen on read.
        assert_eq!(m.schema_version, CURRENT_SCHEMA_VERSION);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_round_trip() {
        let mut m = Manifest::new("buck-converter");
        m.designs.push(Design {
            id: "design-1".into(),
            source_name: "buck.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/top.gbr".into(),
                layer_type: crate::layer::LayerType::TopCopper,
            }],
        });
        m.layer_colors
            .insert(crate::layer::LayerType::TopCopper, "#b87333".into());
        let json = serde_json::to_string_pretty(&m).unwrap();
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(
            back.layer_colors
                .get(&crate::layer::LayerType::TopCopper)
                .map(String::as_str),
            Some("#b87333")
        );
    }

    #[test]
    fn missing_optional_fields_default() {
        let json = r#"{"schema_version":1,"name":"x","designs":[]}"#;
        let m = crate::document::migrate::manifest_from_slice(json.as_bytes()).unwrap();
        assert!(m.description.is_empty());
        assert!(m.exposure.is_none());
        assert!(m.layer_colors.is_empty());
    }

    #[test]
    fn manifest_stackup_round_trips_and_defaults_none() {
        // Old files without `stackup` deserialize to None.
        let json = r#"{"schema_version":3,"name":"x","designs":[]}"#;
        let m = crate::document::migrate::manifest_from_slice(json.as_bytes()).unwrap();
        assert!(m.stackup.is_none());

        // A stackup without `double_sided` (older shape) defaults to single-sided.
        let s: Stackup =
            serde_json::from_str(r#"{"copper_weight_oz":1.0,"substrate_thickness_mm":1.6}"#)
                .unwrap();
        assert!(!s.double_sided);

        // A set stackup survives a round-trip.
        let mut m2 = Manifest::new("y");
        m2.stackup = Some(Stackup {
            copper_weight_oz: 1.0,
            substrate_thickness_mm: 1.6,
            double_sided: true,
        });
        let back: Manifest = serde_json::from_str(&serde_json::to_string(&m2).unwrap()).unwrap();
        assert_eq!(m2, back);
    }
}
