//! Release-mode benchmarks for the DFM measurement path on a dense real board.
//!
//! Fixture: `plaid` — an open-hardware 4x12 ortholinear keyboard PCB (~25k copper
//! edges, ~39k silk segments, 537 drills). This is the board whose cold
//! `board_metrics` was the profiling target; the traces taken from `pnpm tauri dev`
//! are debug + under load and can't decide a perf change, so these benches give a
//! stable release-mode number for `board_metrics` end-to-end and for the sweep
//! (`clearance_width_hotspots`) in isolation.
//!
//! Run: `cargo bench -p cuprum-core --bench board_metrics`

use criterion::{criterion_group, criterion_main, Criterion};
use cuprum_core::geometry;
use cuprum_core::mesh::{Role, Side};
use cuprum_core::metrics::{board_metrics, MetricLayerInput};

const F_CU: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-F_Cu.gtl");
const B_CU: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-B_Cu.gbl");
const F_MASK: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-F_Mask.gts");
const B_MASK: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-B_Mask.gbs");
const F_SILK: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-F_SilkS.gto");
const B_SILK: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-B_SilkS.gbo");
const EDGE: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-Edge_Cuts.gm1");
const PTH: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-PTH.drl");
const NPTH: &[u8] = include_bytes!("../../../testdata/gerber/plaid/plaid-NPTH.drl");

/// The plaid layer set as `board_metrics` inputs, mirroring `main.rs`'s role/side
/// mapping (PTH plated, NPTH not).
fn plaid_inputs() -> Vec<MetricLayerInput<'static>> {
    let layer = |role, side, bytes| MetricLayerInput {
        role,
        side,
        inner: false,
        plated: false,
        bytes,
    };
    vec![
        layer(Role::Copper, Side::Top, F_CU),
        layer(Role::Copper, Side::Bottom, B_CU),
        layer(Role::Mask, Side::Top, F_MASK),
        layer(Role::Mask, Side::Bottom, B_MASK),
        layer(Role::Silk, Side::Top, F_SILK),
        layer(Role::Silk, Side::Bottom, B_SILK),
        layer(Role::Edge, Side::Both, EDGE),
        MetricLayerInput {
            role: Role::Drill,
            side: Side::Both,
            inner: false,
            plated: true,
            bytes: PTH,
        },
        layer(Role::Drill, Side::Both, NPTH),
    ]
}

fn bench_board_metrics(c: &mut Criterion) {
    let inputs = plaid_inputs();
    let mut g = c.benchmark_group("board_metrics");
    // ~1s per iteration: keep the run bounded.
    g.sample_size(10);
    g.bench_function("plaid", |b| b.iter(|| board_metrics(&inputs)));
    g.finish();
}

fn bench_sweep(c: &mut Criterion) {
    // The clearance+width sweep on the dense front-copper union — the hotspot the
    // chunking knob (`TARGET_CHUNK_EDGES`) targets. Parse once outside the timer.
    let polys = geometry::layer_polygons(F_CU, &[]).expect("plaid F_Cu parses");
    let mut g = c.benchmark_group("sweep");
    g.sample_size(10);
    g.bench_function("clearance_width/plaid_F_Cu", |b| {
        b.iter(|| geometry::clearance_width_hotspots(&polys))
    });
    g.finish();
}

criterion_group!(benches, bench_board_metrics, bench_sweep);
criterion_main!(benches);
