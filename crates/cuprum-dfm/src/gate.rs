//! Minimal DFM gate: compare measured minimums against hard limits → pass/fail.
//! NOT the full GUI `Finding` taxonomy (that verdict lives in TS and will be
//! ported to a shared Rust verdict later). v1 = a CI-friendly manufacturability gate.

use serde::{Deserialize, Serialize};

use crate::BoardMetrics;

/// Hard manufacturability limits (mm). Defaults are conservative home-fab values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateProfile {
    pub min_trace_mm: f32,
    pub min_clearance_mm: f32,
    pub min_drill_mm: f32,
    pub min_annular_mm: f32,
}

impl Default for GateProfile {
    fn default() -> Self {
        Self {
            min_trace_mm: 0.15,
            min_clearance_mm: 0.15,
            min_drill_mm: 0.3,
            min_annular_mm: 0.13,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GateSeverity {
    Ok,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateFailure {
    pub limit: String,
    pub measured_mm: f32,
    pub limit_mm: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateReport {
    pub worst: GateSeverity,
    pub failures: Vec<GateFailure>,
}

/// Compare measured minimums to the profile; any breach → Block.
pub fn gate(m: &BoardMetrics, p: &GateProfile) -> GateReport {
    let mut failures = Vec::new();
    let mut check = |name: &'static str, measured: Option<f32>, limit: f32| {
        if let Some(v) = measured {
            if v < limit {
                failures.push(GateFailure {
                    limit: name.to_string(),
                    measured_mm: v,
                    limit_mm: limit,
                });
            }
        }
    };
    // Worst (smallest) trace across copper layers.
    let min_trace = m
        .copper
        .iter()
        .filter_map(|c| c.min_trace_mm)
        .fold(None, |acc: Option<f32>, v| {
            Some(acc.map_or(v, |a| a.min(v)))
        });
    check("min_trace_mm", min_trace, p.min_trace_mm);
    check(
        "min_clearance_mm",
        m.geo.min_clearance_mm,
        p.min_clearance_mm,
    );
    check("min_drill_mm", m.drill.min_hole_mm, p.min_drill_mm);
    check("min_annular_mm", m.geo.min_annular_mm, p.min_annular_mm);
    let worst = if failures.is_empty() {
        GateSeverity::Ok
    } else {
        GateSeverity::Block
    };
    GateReport { worst, failures }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Use the sub-types now re-exported from the metrics module.
    use crate::metrics::{BoardDims, CopperLayerMetric, DrillMetrics, GeoMetrics, LayerSummary};

    fn board_dims() -> BoardDims {
        BoardDims {
            width_mm: 50.0,
            height_mm: 50.0,
            outline_closed: true,
            cutout_count: 0,
            has_edge_layer: true,
        }
    }

    fn metrics_with(
        min_trace: f32,
        min_clear: f32,
        min_hole: f32,
        min_annular: f32,
    ) -> BoardMetrics {
        BoardMetrics {
            board: board_dims(),
            layers: LayerSummary::default(),
            copper: vec![CopperLayerMetric {
                side: "top".to_string(),
                min_trace_mm: Some(min_trace),
                trace_widths_mm: vec![min_trace],
                primitive_count: 1,
            }],
            drill: DrillMetrics {
                min_hole_mm: Some(min_hole),
                ..Default::default()
            },
            geo: GeoMetrics {
                min_clearance_mm: Some(min_clear),
                min_annular_mm: Some(min_annular),
                ..Default::default()
            },
        }
    }

    #[test]
    fn gate_passes_when_above_limits() {
        let p = GateProfile::default();
        let m = metrics_with(
            p.min_trace_mm * 2.0,
            p.min_clearance_mm * 2.0,
            p.min_drill_mm * 2.0,
            p.min_annular_mm * 2.0,
        );
        assert_eq!(gate(&m, &p).worst, GateSeverity::Ok);
    }

    #[test]
    fn gate_blocks_a_too_thin_trace() {
        let p = GateProfile::default();
        let m = metrics_with(
            p.min_trace_mm * 0.5,
            p.min_clearance_mm * 2.0,
            p.min_drill_mm * 2.0,
            p.min_annular_mm * 2.0,
        );
        let r = gate(&m, &p);
        assert_eq!(r.worst, GateSeverity::Block);
        assert!(
            r.failures.iter().any(|f| f.limit == "min_trace_mm"),
            "expected min_trace_mm failure"
        );
    }
}
