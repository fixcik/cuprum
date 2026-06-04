//! Drill file statistics: total holes, unique diameters, plated/non-plated split.

use std::collections::BTreeMap;

use cuprum_mesh::Role;

use super::parse::DrillData;
use super::types::{DrillMetrics, MetricLayerInput};

/// Aggregate drill statistics across all drill files.
pub(super) fn drill_metrics(
    layers: &[MetricLayerInput],
    drills: &[Option<DrillData>],
) -> DrillMetrics {
    // Bucket by diameter in integer micrometres to dedupe float noise.
    let mut hist: BTreeMap<u32, u32> = BTreeMap::new();
    let mut m = DrillMetrics::default();
    for (i, l) in layers
        .iter()
        .enumerate()
        .filter(|(_, l)| l.role == Role::Drill)
    {
        let Some(d) = drills[i].as_ref() else {
            continue;
        };
        for h in &d.holes {
            if h.d_mm <= 0.0 {
                continue;
            }
            m.total_holes += 1;
            if l.plated {
                m.plated_hole_count += 1;
            } else {
                m.nonplated_hole_count += 1;
            }
            let um = (h.d_mm * 1000.0).round() as u32;
            *hist.entry(um).or_insert(0) += 1;
            m.min_hole_mm = Some(m.min_hole_mm.map_or(h.d_mm, |cur| cur.min(h.d_mm)));
        }
    }
    m.unique_tool_diameters_mm = hist.keys().map(|um| *um as f32 / 1000.0).collect();
    m.diameter_histogram = hist
        .iter()
        .map(|(um, c)| (*um as f32 / 1000.0, *c))
        .collect();
    m
}
