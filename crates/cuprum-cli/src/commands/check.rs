//! `cuprum check <input> [--profile p.json]` — measured DFM metrics + a gate.

use std::path::{Path, PathBuf};

use anyhow::Result;
use cuprum_core::dfm::{board_metrics, gate, GateProfile, GateSeverity, MetricLayerInput};
use cuprum_project::layer::{role_side, LayerType};
use cuprum_project::resolve::{resolve_design, ResolveOpts};

use crate::output::EXIT_GATE_FAIL;

/// Returns the process exit code (gate failure → EXIT_GATE_FAIL).
pub fn run(input: &Path, profile_path: Option<PathBuf>, json: bool, hotspots: bool) -> Result<i32> {
    let rd = resolve_design(input, &ResolveOpts::default())?;
    let inputs: Vec<MetricLayerInput> = rd
        .layers
        .iter()
        .map(|l| {
            let (role, side) = role_side(l.kind);
            MetricLayerInput {
                role,
                side,
                inner: l.kind == LayerType::InnerCopper,
                plated: role == cuprum_core::mesh::Role::Drill
                    && !l.rel.to_lowercase().contains("npth"),
                bytes: &l.bytes,
            }
        })
        .collect();
    let mut metrics = board_metrics(&inputs);
    let profile: GateProfile = match profile_path {
        Some(p) => serde_json::from_slice(&std::fs::read(&p)?)?,
        None => GateProfile::default(),
    };
    let report = gate(&metrics, &profile);
    // Strip hotspot lists from output unless --hotspots is given.
    if !hotspots {
        metrics.clear_hotspots();
    }

    if json {
        println!(
            "{}",
            serde_json::json!({ "metrics": metrics, "gate": report })
        );
    } else {
        let min_trace = metrics
            .copper
            .iter()
            .filter_map(|c| c.min_trace_mm)
            .fold(f32::INFINITY, f32::min);
        println!("DFM metrics for {}:", input.display());
        println!("  min trace:     {}", fmt_mm(min_trace));
        println!("  min clearance: {}", fmt_opt(metrics.geo.min_clearance_mm));
        println!("  min drill:     {}", fmt_opt(metrics.drill.min_hole_mm));
        println!("  min annular:   {}", fmt_opt(metrics.geo.min_annular_mm));
        match report.worst {
            GateSeverity::Ok => println!("gate: OK"),
            GateSeverity::Block => {
                println!("gate: FAIL");
                for f in &report.failures {
                    println!("  {} {:.3}mm < {:.3}mm", f.limit, f.measured_mm, f.limit_mm);
                }
            }
        }
        if hotspots {
            let groups = metrics.geo.hotspot_groups();
            let total: usize = groups.iter().map(|(_, g)| g.len()).sum();
            println!("hotspots ({total}):");
            for (name, g) in groups {
                if let Some(w) = g.first() {
                    println!(
                        "  {name}: {} (worst {:.3}mm @ {:.2},{:.2})",
                        g.len(),
                        w.v,
                        w.a[0],
                        w.a[1]
                    );
                }
            }
        }
    }
    Ok(if matches!(report.worst, GateSeverity::Block) {
        EXIT_GATE_FAIL
    } else {
        0
    })
}

fn fmt_mm(v: f32) -> String {
    if v.is_finite() {
        format!("{v:.3}mm")
    } else {
        "—".into()
    }
}
fn fmt_opt(v: Option<f32>) -> String {
    v.map(|x| format!("{x:.3}mm")).unwrap_or_else(|| "—".into())
}
