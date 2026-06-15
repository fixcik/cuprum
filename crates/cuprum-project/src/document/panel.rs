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

/// Which axis the fiducial row runs along.
///
/// `X` means holes are spaced horizontally (the row is parallel to the X axis).
/// `Y` means holes are spaced vertically (the row is parallel to the Y axis).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FiducialAxis {
    #[default]
    X,
    Y,
}

/// Persisted parameters for the auto-fiducial tool.
///
/// These describe how the user wants to scatter fiducial (registration) holes
/// across the panel blank.  The geometry is always symmetric about the panel
/// centre on the chosen axis.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FiducialParams {
    /// Axis along which holes are spaced (default: `X`).
    #[serde(default)]
    pub axis: FiducialAxis,
    /// Number of holes to place (≥ 2).
    pub count: u32,
    /// Centre-to-centre spacing between adjacent holes (mm).
    pub step_mm: f32,
    /// Hole diameter (mm).
    pub diameter_mm: f32,
    /// Distance from the panel edge perpendicular to the axis to the hole
    /// centre (mm).  For axis `X` this is the Y offset from the top edge;
    /// for axis `Y` this is the X offset from the left edge.
    pub edge_offset_mm: f32,
}

impl Default for FiducialParams {
    fn default() -> Self {
        Self {
            axis: FiducialAxis::X,
            count: 2,
            step_mm: 50.0,
            diameter_mm: 3.0,
            edge_offset_mm: 5.0,
        }
    }
}

/// One fiducial position in panel space (mm).  The `id` field is filled by
/// the caller when converting to `ToolingHole` entries.
#[derive(Debug, Clone, PartialEq)]
pub struct FiducialPosition {
    pub x_mm: f32,
    pub y_mm: f32,
}

/// Place `params.count` fiducials symmetrically about the panel centre along
/// the axis specified by `params.axis`.
///
/// The layout is centred on the panel centre of the chosen axis, with adjacent
/// holes separated by `params.step_mm`.  `params.edge_offset_mm` positions the
/// row offset from the panel edge perpendicular to the axis.
///
/// Returns an empty `Vec` if the panel is too small to fit any hole, but never
/// fewer than `count` holes when the dimensions are reasonable.
pub fn place_fiducials(
    panel_width_mm: f32,
    panel_height_mm: f32,
    params: &FiducialParams,
) -> Vec<FiducialPosition> {
    let n = params.count.max(2) as f32;
    // Total span of the row: (N-1) * step.
    let span = (n - 1.0) * params.step_mm;

    match params.axis {
        FiducialAxis::X => {
            // Row is horizontal: centres along X, fixed Y.
            let centre_x = panel_width_mm / 2.0;
            let y = params.edge_offset_mm.clamp(0.0, panel_height_mm);
            let x0 = centre_x - span / 2.0;
            (0..params.count.max(2))
                .map(|i| FiducialPosition {
                    x_mm: x0 + i as f32 * params.step_mm,
                    y_mm: y,
                })
                .collect()
        }
        FiducialAxis::Y => {
            // Row is vertical: centres along Y, fixed X.
            let centre_y = panel_height_mm / 2.0;
            let x = params.edge_offset_mm.clamp(0.0, panel_width_mm);
            let y0 = centre_y - span / 2.0;
            (0..params.count.max(2))
                .map(|i| FiducialPosition {
                    x_mm: x,
                    y_mm: y0 + i as f32 * params.step_mm,
                })
                .collect()
        }
    }
}

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
    /// Persisted parameters for the auto-fiducial placement tool.  `None` means
    /// the user has not configured auto-fiducials yet; the UI seeds from
    /// `FiducialParams::default()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiducial_params: Option<FiducialParams>,
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
            fiducial_params: None,
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

    // ── FiducialParams & place_fiducials ────────────────────────────────────────

    #[test]
    fn fiducial_params_default_values() {
        let p = FiducialParams::default();
        assert_eq!(p.axis, FiducialAxis::X);
        assert_eq!(p.count, 2);
        assert!((p.step_mm - 50.0).abs() < 1e-5);
        assert!((p.diameter_mm - 3.0).abs() < 1e-5);
        assert!((p.edge_offset_mm - 5.0).abs() < 1e-5);
    }

    #[test]
    fn fiducial_params_round_trips() {
        let p = FiducialParams {
            axis: FiducialAxis::Y,
            count: 3,
            step_mm: 40.0,
            diameter_mm: 2.5,
            edge_offset_mm: 8.0,
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: FiducialParams = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn fiducial_axis_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&FiducialAxis::X).unwrap(), "\"x\"");
        assert_eq!(serde_json::to_string(&FiducialAxis::Y).unwrap(), "\"y\"");
    }

    /// Two holes along X must be symmetric about the panel centre X.
    #[test]
    fn place_fiducials_x_axis_two_symmetric() {
        let params = FiducialParams {
            axis: FiducialAxis::X,
            count: 2,
            step_mm: 60.0,
            diameter_mm: 3.0,
            edge_offset_mm: 5.0,
        };
        let holes = place_fiducials(200.0, 100.0, &params);
        assert_eq!(holes.len(), 2);
        let cx = 200.0_f32 / 2.0;
        // Both holes must be equidistant from the panel centre on X.
        let d0 = (holes[0].x_mm - cx).abs();
        let d1 = (holes[1].x_mm - cx).abs();
        assert!((d0 - d1).abs() < 1e-4, "not symmetric: d0={d0} d1={d1}");
        // Y is the edge offset.
        assert!((holes[0].y_mm - 5.0).abs() < 1e-4);
        assert!((holes[1].y_mm - 5.0).abs() < 1e-4);
    }

    /// N=4, axis=X, step=30: row should span 90mm centred at 100mm centre of 200mm panel.
    #[test]
    fn place_fiducials_x_axis_four_correct_step() {
        let params = FiducialParams {
            axis: FiducialAxis::X,
            count: 4,
            step_mm: 30.0,
            diameter_mm: 3.0,
            edge_offset_mm: 5.0,
        };
        let holes = place_fiducials(200.0, 100.0, &params);
        assert_eq!(holes.len(), 4);
        // Span = (4-1)*30 = 90 mm; x0 = 100 - 45 = 55.
        let expected_xs = [55.0_f32, 85.0, 115.0, 145.0];
        for (h, &ex) in holes.iter().zip(expected_xs.iter()) {
            assert!((h.x_mm - ex).abs() < 1e-4, "x={} expected={}", h.x_mm, ex);
        }
    }

    /// Two holes along Y must be symmetric about the panel centre Y.
    #[test]
    fn place_fiducials_y_axis_two_symmetric() {
        let params = FiducialParams {
            axis: FiducialAxis::Y,
            count: 2,
            step_mm: 40.0,
            diameter_mm: 3.0,
            edge_offset_mm: 6.0,
        };
        let holes = place_fiducials(150.0, 120.0, &params);
        assert_eq!(holes.len(), 2);
        let cy = 120.0_f32 / 2.0;
        let d0 = (holes[0].y_mm - cy).abs();
        let d1 = (holes[1].y_mm - cy).abs();
        assert!((d0 - d1).abs() < 1e-4, "not symmetric: d0={d0} d1={d1}");
        // X is the edge offset.
        assert!((holes[0].x_mm - 6.0).abs() < 1e-4);
        assert!((holes[1].x_mm - 6.0).abs() < 1e-4);
    }

    /// place_fiducials returns exactly `count` holes.
    #[test]
    fn place_fiducials_returns_exact_count() {
        for n in [2u32, 3, 5, 7] {
            let params = FiducialParams {
                count: n,
                step_mm: 10.0,
                ..FiducialParams::default()
            };
            let holes = place_fiducials(200.0, 100.0, &params);
            assert_eq!(
                holes.len() as u32,
                n,
                "expected {n} holes, got {}",
                holes.len()
            );
        }
    }

    /// A panel doc without `fiducial_params` must deserialise with `None`.
    #[test]
    fn panel_without_fiducial_params_defaults_none() {
        let json = r#"{"schema_version":4,"width_mm":100.0,"height_mm":80.0}"#;
        let p: PanelDoc = serde_json::from_str(json).unwrap();
        assert!(p.fiducial_params.is_none());
    }

    /// A panel doc with `fiducial_params` must round-trip correctly.
    #[test]
    fn panel_with_fiducial_params_round_trips() {
        let fp = FiducialParams {
            axis: FiducialAxis::Y,
            count: 3,
            step_mm: 30.0,
            diameter_mm: 2.0,
            edge_offset_mm: 7.0,
        };
        let mut p = PanelDoc::new(100.0, 80.0);
        p.fiducial_params = Some(fp.clone());
        let json = serde_json::to_string(&p).unwrap();
        let back: PanelDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back.fiducial_params, Some(fp));
    }

    /// `fiducial_params` is omitted from serialisation when `None`
    /// (keeps the on-disk payload compact for old projects).
    #[test]
    fn panel_fiducial_params_omitted_when_none() {
        let p = PanelDoc::new(100.0, 80.0);
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            !json.contains("fiducial_params"),
            "fiducial_params key should be absent: {json}"
        );
    }
}
