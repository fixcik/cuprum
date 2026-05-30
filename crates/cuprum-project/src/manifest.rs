//! Project manifest — the `manifest.json` inside a `.cuprum` container.

use crate::layer::LayerType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Bump when the on-disk shape changes incompatibly. v2: gerbers carry a layer type.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Manifest {
    pub schema_version: u32,
    pub name: String,
    /// User-facing project notes shown on the project page.
    #[serde(default)]
    pub description: String,
    /// Imported Gerber packages (one per source ZIP).
    #[serde(default)]
    pub imports: Vec<Import>,
    /// Exposure settings — filled when the editor is wired in. Optional now.
    #[serde(default)]
    pub exposure: Option<Exposure>,
    /// Placements on the board — filled when the editor is wired in.
    #[serde(default)]
    pub placements: Vec<Placement>,
    /// Optional per-layer-type colour overrides (hex like "#b87333"); empty = use
    /// the UI's default palette. Visibility is UI-only and not persisted.
    #[serde(default)]
    pub layer_colors: BTreeMap<LayerType, String>,
}

impl Manifest {
    /// A fresh, empty manifest with the current schema version.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            name: name.into(),
            description: String::new(),
            imports: Vec::new(),
            exposure: None,
            placements: Vec::new(),
            layer_colors: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Import {
    /// Stable id within the container, e.g. "import-1".
    pub id: String,
    /// Original ZIP file name (for display).
    pub source_name: String,
    /// Gerber files in this import, with their classified layer type.
    pub gerbers: Vec<GerberFile>,
}

/// One gerber file inside the container plus its layer classification.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GerberFile {
    /// Relative path inside the container, e.g. "gerbers/import-1/top.gbr".
    pub path: String,
    pub layer_type: LayerType,
}

// Accept both v2 (`{path, layer_type}`) and v1 (bare `"path"` string) forms.
impl<'de> Deserialize<'de> for GerberFile {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Compat {
            Legacy(String),
            Full {
                path: String,
                #[serde(default)]
                layer_type: LayerType,
            },
        }
        Ok(match Compat::deserialize(de)? {
            Compat::Legacy(path) => GerberFile {
                path,
                layer_type: LayerType::Other,
            },
            Compat::Full { path, layer_type } => GerberFile { path, layer_type },
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Panel {
    pub w_mm: f32,
    pub h_mm: f32,
    pub x_mm: f32,
    pub y_mm: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Exposure {
    pub mirror: bool,
    pub invert: bool,
    pub exposure_s: f32,
    pub pwm: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Placement {
    /// Relative path to the Gerber inside the container.
    pub gerber: String,
    pub x_mm: f32,
    pub y_mm: f32,
    pub rotation_deg: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_round_trip() {
        let mut m = Manifest::new("buck-converter");
        m.imports.push(Import {
            id: "import-1".into(),
            source_name: "buck.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/import-1/top.gbr".into(),
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
    fn reads_v1_gerbers_as_strings() {
        // v1 stored gerbers as a bare string array; they must migrate to Other.
        let json = r#"{"schema_version":1,"name":"x","imports":[
            {"id":"import-1","source_name":"a.zip","gerbers":["gerbers/import-1/a.gbr"]}
        ]}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.imports[0].gerbers.len(), 1);
        assert_eq!(m.imports[0].gerbers[0].path, "gerbers/import-1/a.gbr");
        assert_eq!(
            m.imports[0].gerbers[0].layer_type,
            crate::layer::LayerType::Other
        );
        assert!(m.layer_colors.is_empty());
    }

    #[test]
    fn missing_optional_fields_default() {
        let json = r#"{"schema_version":1,"name":"x","imports":[]}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert!(m.description.is_empty());
        assert!(m.exposure.is_none());
        assert!(m.placements.is_empty());
        assert!(m.layer_colors.is_empty());
    }
}
