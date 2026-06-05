//! FR4 blank definition (`PanelDoc`): size, panel-space origin, board instances,
//! tooling holes, keep-out zones, and per-diameter drill-class overrides.
//! Embedded in `Manifest::panel` (manifest schema v4+; previously a separate
//! `panel.json` entry). `PanelDoc` itself is schema v4 (added
//! `drill_class_overrides`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Class of a drill hole. Mirrors the TS `DrillClass` literals.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DrillClass {
    Registration,
    Pth,
    Npth,
    Mechanical,
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
}

/// An axis-aligned rectangular keep-out zone in panel space.
///
/// Uniform forbidden rectangle: boards AND any tooling holes must not enter;
/// the machine routes around it during drilling. Legacy documents may carry a
/// `"kind"` field — it is silently ignored on load (no `deny_unknown_fields`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KeepOutZone {
    /// Stable id within the panel, e.g. "koz-1".
    pub id: String,
    /// Top-left corner X in panel space (mm).
    pub x_mm: f64,
    /// Top-left corner Y in panel space (mm).
    pub y_mm: f64,
    /// Width in mm (always positive).
    pub width_mm: f64,
    /// Height in mm (always positive).
    pub height_mm: f64,
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
/// v3: panel carries keep-out zones (`keep_out_zones`).
/// v4: panel carries per-diameter drill-class overrides (`drill_class_overrides`).
pub const CURRENT_PANEL_SCHEMA_VERSION: u32 = 4;

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
    /// Keep-out zones on this panel.
    #[serde(default)]
    pub keep_out_zones: Vec<KeepOutZone>,
    /// Manual per-diameter class overrides. Key = diameter bucket in microns
    /// (`round(diameter_mm * 1000)` as a decimal string, matching the TS
    /// `bucketKey`); value = the forced class. Entries with an unrecognised
    /// class value are dropped on load (forward/legacy tolerance).
    #[serde(default, deserialize_with = "de_lenient_overrides")]
    pub drill_class_overrides: BTreeMap<String, DrillClass>,
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
            keep_out_zones: Vec::new(),
            drill_class_overrides: BTreeMap::new(),
        }
    }
}

/// Deserialize the override map, silently dropping entries whose value is not a
/// known `DrillClass` (so a newer/older file never fails the whole load).
fn de_lenient_overrides<'de, D>(d: D) -> Result<BTreeMap<String, DrillClass>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: BTreeMap<String, serde_json::Value> = BTreeMap::deserialize(d)?;
    Ok(raw
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value::<DrillClass>(v).ok().map(|c| (k, c)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        let json = serde_json::to_string(&inst).unwrap();
        assert_eq!(serde_json::from_str::<BoardInstance>(&json).unwrap(), inst);
    }

    #[test]
    fn board_instance_ignores_legacy_layer_ref() {
        // Older projects persisted a per-instance `layerRef` (placement side). The
        // field is gone now; legacy files must still load, with it ignored.
        let json = r#"{"id":"i","design_id":"d","x_mm":1.0,"y_mm":2.0,"rotation_deg":0.0,"layer_ref":"Bottom"}"#;
        let inst: BoardInstance = serde_json::from_str(json).unwrap();
        assert_eq!(inst.id, "i");
        assert_eq!(inst.x_mm, 1.0);
        assert_eq!(inst.y_mm, 2.0);
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
    fn panel_new_is_schema_v4_empty() {
        let p = PanelDoc::new(150.0, 100.0);
        assert_eq!(p.schema_version, CURRENT_PANEL_SCHEMA_VERSION);
        assert!(p.instances.is_empty());
        assert!(p.tooling_holes.is_empty());
        assert!(p.keep_out_zones.is_empty());
        assert!(p.drill_class_overrides.is_empty());
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

    #[test]
    fn keep_out_zone_round_trips() {
        let z = KeepOutZone {
            id: "koz-1".into(),
            x_mm: 10.0,
            y_mm: 5.0,
            width_mm: 20.0,
            height_mm: 15.0,
        };
        let json = serde_json::to_string(&z).unwrap();
        assert_eq!(serde_json::from_str::<KeepOutZone>(&json).unwrap(), z);
    }

    #[test]
    fn keep_out_zone_legacy_kind_field_ignored() {
        // Legacy documents carry a "kind" field ("fixture"/"dead"/"reserved").
        // It must be silently ignored on load (struct has no deny_unknown_fields).
        let json = r#"{"id":"koz-2","x_mm":5.0,"y_mm":3.0,"width_mm":12.0,"height_mm":8.0,"kind":"fixture"}"#;
        let z: KeepOutZone = serde_json::from_str(json).unwrap();
        assert_eq!(z.id, "koz-2");
        assert_eq!(z.x_mm, 5.0);
        assert_eq!(z.width_mm, 12.0);

        let json_dead =
            r#"{"id":"koz-3","x_mm":1.0,"y_mm":2.0,"width_mm":3.0,"height_mm":4.0,"kind":"dead"}"#;
        let z2: KeepOutZone = serde_json::from_str(json_dead).unwrap();
        assert_eq!(z2.id, "koz-3");

        let json_reserved = r#"{"id":"koz-4","x_mm":2.0,"y_mm":3.0,"width_mm":5.0,"height_mm":6.0,"kind":"reserved"}"#;
        let z3: KeepOutZone = serde_json::from_str(json_reserved).unwrap();
        assert_eq!(z3.id, "koz-4");
    }

    #[test]
    fn panel_without_keep_out_zones_deserializes_empty() {
        // Old v2 PanelDoc (no keep_out_zones field) must deserialise to an empty vec.
        let json = r#"{"schema_version":2,"width_mm":200.0,"height_mm":100.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert!(p.keep_out_zones.is_empty());
    }

    #[test]
    fn panel_v1_loads_with_empty_keep_out_zones() {
        let json = r#"{"schema_version":1,"width_mm":200.0,"height_mm":100.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert!(p.keep_out_zones.is_empty());
        assert!(p.instances.is_empty());
        assert!(p.tooling_holes.is_empty());
    }

    #[test]
    fn drill_class_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&DrillClass::Npth).unwrap(),
            "\"npth\""
        );
        assert_eq!(
            serde_json::to_string(&DrillClass::Registration).unwrap(),
            "\"registration\""
        );
    }

    #[test]
    fn panel_round_trips_drill_class_overrides() {
        let mut p = PanelDoc::new(100.0, 80.0);
        p.drill_class_overrides
            .insert("300".into(), DrillClass::Npth);
        p.drill_class_overrides
            .insert("3000".into(), DrillClass::Registration);
        let json = serde_json::to_string(&p).unwrap();
        let back: PanelDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back.drill_class_overrides, p.drill_class_overrides);
    }

    #[test]
    fn panel_without_overrides_defaults_empty() {
        let json = r#"{"schema_version":3,"width_mm":50.0,"height_mm":50.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert!(p.drill_class_overrides.is_empty());
    }

    #[test]
    fn drill_class_overrides_skip_unknown_values() {
        let json = r#"{"schema_version":4,"width_mm":50.0,"height_mm":50.0,
            "drill_class_overrides":{"300":"npth","500":"bogus"}}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert_eq!(p.drill_class_overrides.get("300"), Some(&DrillClass::Npth));
        assert_eq!(p.drill_class_overrides.get("500"), None);
    }
}
