use super::*;
use cuprum_gerber::geometry::{self, Poly};
use cuprum_mesh::{Role, Side};

// 10×10 mm rectangular Edge_Cuts outline (4 stroked sides).
const EDGE_SQUARE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nX0100000Y0100000D01*\nX0Y0100000D01*\nX0Y0D01*\nM02*\n";
// A copper layer with one 0.2 mm horizontal trace from (0,0) to (10,0).
const CU_TRACE: &[u8] =
    b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nM02*\n";
// PTH drill: two 0.3 mm holes and one 0.8 mm hole.
const PTH: &[u8] =
    b"M48\nMETRIC,TZ\nT1C0.300\nT2C0.800\n%\nT1\nX1.0Y1.0\nX2.0Y1.0\nT2\nX3.0Y3.0\nM30\n";
// NPTH drill: one 3.2 mm mounting hole.
const NPTH: &[u8] = b"M48\nMETRIC,TZ\nT1C3.200\n%\nT1\nX5.0Y5.0\nM30\n";

fn edge(bytes: &'static [u8]) -> MetricLayerInput<'static> {
    MetricLayerInput {
        role: Role::Edge,
        side: Side::Both,
        inner: false,
        plated: false,
        bytes,
    }
}

// Real multi-primitive gerbers → non-trivial clearance/width hotspots.
const CU_LAYER_A: &[u8] = include_bytes!("../../../../testdata/gerber/two_square_boxes.gbr");
const CU_LAYER_B: &[u8] =
    include_bytes!("../../../../testdata/gerber/polarities_and_apertures.gbr");

// Bit-identical guard for the parallelized hotspot loops (Phase 1): the
// production helper must match an in-process SEQUENTIAL recomputation exactly
// — same per-layer order, same values. In-process so it is platform-independent
// (float results cancel) and catches any reordering/divergence from rayon.
#[test]
fn copper_hotspots_match_sequential_reference() {
    let copper = |bytes: &'static [u8], side: Side| MetricLayerInput {
        role: Role::Copper,
        side,
        inner: false,
        plated: false,
        bytes,
    };
    let layers = vec![
        copper(CU_LAYER_A, Side::Top),
        copper(CU_LAYER_B, Side::Bottom),
    ];
    let copper_layers: Vec<(&str, Vec<Poly>)> = layers
        .iter()
        .filter_map(|l| {
            geometry::layer_polygons(l.bytes, &[])
                .ok()
                .map(|p| (layer_side(l), p))
        })
        .filter(|(_, p)| !p.is_empty())
        .collect();

    // Production path (parallel after Phase 1).
    let parsed = parse::parse_all(&layers);
    let (clear, width) = copper::copper_clearance_width_hotspots(&copper_layers, &layers, &parsed);

    // Sequential reference, recomputed here in the same process.
    let mut ref_clear: Vec<Hotspot> = Vec::new();
    for (side, polys) in &copper_layers {
        let (c, _) = crate::sweep::clearance_width_hotspots(polys);
        ref_clear.extend(
            aggregate::top_n(c, crate::HOT_N)
                .into_iter()
                .map(|h| aggregate::to_hotspot(h, side)),
        );
    }
    let mut ref_width: Vec<Hotspot> = Vec::new();
    for l in layers.iter().filter(|l| l.role == Role::Copper) {
        let Ok(region) = geometry::region_polygons(l.bytes, &[]) else {
            continue;
        };
        if region.is_empty() {
            continue;
        }
        let side = layer_side(l);
        let (_, w) = crate::sweep::clearance_width_hotspots(&region);
        ref_width.extend(
            aggregate::top_n(w, crate::HOT_N)
                .into_iter()
                .map(|h| aggregate::to_hotspot(h, side)),
        );
    }

    assert_eq!(clear, ref_clear, "clearance hotspots must match sequential");
    assert_eq!(width, ref_width, "width hotspots must match sequential");
    // Sanity: at least one path yields hotspots on these fixtures (here it's
    // the width path), so the equivalence check above compares real data, not
    // two empty vectors. (clearance is empty here — the two shapes sit beyond
    // the DRC gap radius — so don't tighten this to `!clear.is_empty()`.)
    assert!(
        !clear.is_empty() || !width.is_empty(),
        "fixtures should yield at least one hotspot"
    );
}

// Whole-`board_metrics` guard for the parse-once / zone3 fan-out refactor:
// (a) deterministic — recomputing yields a byte-identical result (catches any
//     non-determinism from parallelism); (b) structural invariants on a rich
//     multi-role fixture (catches gross wiring breakage). Clearance/width float
//     values are covered bit-exactly by `copper_hotspots_match_sequential_reference`.
fn rich_fixture() -> Vec<MetricLayerInput<'static>> {
    let mk = |role, side, bytes: &'static [u8], plated| MetricLayerInput {
        role,
        side,
        inner: false,
        plated,
        bytes,
    };
    vec![
        edge(EDGE_SQUARE),
        mk(Role::Copper, Side::Top, CU_LAYER_A, false),
        mk(Role::Copper, Side::Bottom, CU_LAYER_B, false),
        mk(Role::Drill, Side::Both, PTH, true),
        mk(Role::Mask, Side::Top, CU_LAYER_A, false),
        mk(Role::Silk, Side::Top, CU_TRACE, false),
    ]
}

#[test]
fn board_metrics_deterministic_and_structured() {
    let layers = rich_fixture();
    let a = serde_json::to_string(&board_metrics(&layers)).unwrap();
    let b = serde_json::to_string(&board_metrics(&layers)).unwrap();
    assert_eq!(a, b, "board_metrics must be deterministic across runs");

    // Topological invariants (counts, not float-threshold-dependent → arch-robust):
    // catch gross wiring breakage from the parse-once / zone3 fan-out refactor.
    let m = board_metrics(&layers);
    assert_eq!(m.copper.len(), 2, "two copper layers");
    assert_eq!(m.layers.copper_layer_count, 2);
    assert_eq!(m.geo.trace_count, 7, "conductor model run count");
    assert_eq!(m.geo.drill_hotspots.len(), 3, "3 drill holes");
    assert_eq!(
        m.geo.annular_hotspots.len(),
        3,
        "3 plated holes → 3 annular"
    );
    assert_eq!(m.geo.slot_count, 0);
    assert!(
        !m.geo.copper_width_hotspots.is_empty(),
        "width hotspots present"
    );
    // The CU_LAYER_A/B shapes do not cover the PTH drill positions, so all
    // three holes are bare through-holes → side "both". This is the expected
    // fixture reality; the side-propagation path (pad present → copper side)
    // is exercised by `annular_hotspot_side_attribution`.
    assert!(
        m.geo.annular_hotspots.iter().all(|h| h.side == "both"),
        "bare through-holes must be tagged 'both': {:?}",
        m.geo
            .annular_hotspots
            .iter()
            .map(|h| &h.side)
            .collect::<Vec<_>>()
    );
}

#[test]
fn board_size_from_edge_square() {
    let m = board_metrics(&[edge(EDGE_SQUARE)]);
    assert!(
        (m.board.width_mm - 10.0).abs() < 0.01,
        "w={}",
        m.board.width_mm
    );
    assert!(
        (m.board.height_mm - 10.0).abs() < 0.01,
        "h={}",
        m.board.height_mm
    );
    assert!(m.board.outline_closed, "square outline should be closed");
    assert_eq!(m.board.cutout_count, 0);
    assert!(m.board.has_edge_layer);
}

#[test]
fn board_dims_without_edge_layer_has_zero_origin() {
    // No Edge_Cuts layer at all → both early-return branches must yield origin (0, 0).
    let no_edge = board_metrics(&[MetricLayerInput {
        role: Role::Copper,
        side: Side::Top,
        inner: false,
        plated: false,
        bytes: CU_TRACE,
    }]);
    assert_eq!(no_edge.board.origin_x_mm, 0.0, "no-edge origin_x");
    assert_eq!(no_edge.board.origin_y_mm, 0.0, "no-edge origin_y");
}

#[test]
fn no_edge_layer_is_flagged() {
    let m = board_metrics(&[MetricLayerInput {
        role: Role::Copper,
        side: Side::Top,
        inner: false,
        plated: false,
        bytes: CU_TRACE,
    }]);
    assert!(!m.board.has_edge_layer);
    assert_eq!(m.board.width_mm, 0.0);
}

#[test]
fn min_trace_from_copper() {
    let m = board_metrics(&[MetricLayerInput {
        role: Role::Copper,
        side: Side::Top,
        inner: false,
        plated: false,
        bytes: CU_TRACE,
    }]);
    assert_eq!(m.layers.copper_layer_count, 1);
    assert!(m.layers.copper_top);
    assert_eq!(m.copper.len(), 1);
    let t = m.copper[0].min_trace_mm.expect("trace width");
    assert!((t - 0.2).abs() < 0.01, "min_trace={t}");
    assert_eq!(m.copper[0].side, "top");
}

#[test]
fn layer_summary_counts_sides_and_inner() {
    let layers = vec![
        MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        },
        MetricLayerInput {
            role: Role::Copper,
            side: Side::Bottom,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        },
        // Inner copper is mapped to Side::Top by the caller; `inner` disambiguates it.
        MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: true,
            plated: false,
            bytes: CU_TRACE,
        },
        MetricLayerInput {
            role: Role::Mask,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        },
    ];
    let m = board_metrics(&layers);
    assert!(m.layers.copper_top && m.layers.copper_bottom);
    assert_eq!(m.layers.inner_copper_count, 1);
    assert_eq!(m.layers.copper_layer_count, 3);
    assert!(m.layers.has_mask_top && !m.layers.has_mask_bottom);
}

#[test]
fn drill_stats_split_plated_and_tools() {
    let layers = vec![
        MetricLayerInput {
            role: Role::Drill,
            side: Side::Both,
            inner: false,
            plated: true,
            bytes: PTH,
        },
        MetricLayerInput {
            role: Role::Drill,
            side: Side::Both,
            inner: false,
            plated: false,
            bytes: NPTH,
        },
    ];
    let m = board_metrics(&layers);
    assert_eq!(m.drill.total_holes, 4, "3 PTH + 1 NPTH");
    assert_eq!(m.drill.plated_hole_count, 3);
    assert_eq!(m.drill.nonplated_hole_count, 1);
    assert_eq!(m.drill.unique_tool_diameters_mm, vec![0.3, 0.8, 3.2]);
    assert!((m.drill.min_hole_mm.unwrap() - 0.3).abs() < 0.001);
    // histogram: 0.3→2, 0.8→1, 3.2→1
    assert_eq!(
        m.drill.diameter_histogram,
        vec![(0.3, 2), (0.8, 1), (3.2, 1)]
    );
    // Holes go through the board → their hotspots are side "both".
    assert!(
        m.geo.drill_hotspots.iter().all(|h| h.side == "both"),
        "drill hotspots are both-sided"
    );
}

#[test]
fn geo_coverage_and_no_slots() {
    let m = board_metrics(&[
        edge(EDGE_SQUARE),
        MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_TRACE,
        },
    ]);
    let cov = m.geo.copper_coverage_pct.expect("coverage measured");
    assert!(cov > 0.0 && cov < 100.0, "0–100% coverage: {cov}");
    assert_eq!(m.geo.slot_count, 0);
    assert!(m.geo.min_slot_width_mm.is_none());
    // A top-copper trace's hotspots are tagged "top" (so the preview can hide
    // them while the bottom face is being viewed).
    assert!(
        m.geo.trace_hotspots.iter().all(|h| h.side == "top"),
        "trace hotspots are top-sided"
    );
}

#[test]
fn silk_widths_keep_artefact_and_real_stroke() {
    // A silk layer with a 0.01 mm artefact stroke + a real 0.07 mm stroke:
    // the backend must surface BOTH (sorted), so the frontend can drop the
    // sub-artefact one before taking the min (a single global min would hide
    // the real 0.07 mm thin silk).
    const SILK: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.01*%\n%ADD11C,0.07*%\nD10*\nX0Y0D02*\nX0010000Y0D01*\nD11*\nX0Y0010000D02*\nX0010000Y0010000D01*\nM02*\n";
    let m = board_metrics(&[MetricLayerInput {
        role: Role::Silk,
        side: Side::Top,
        inner: false,
        plated: false,
        bytes: SILK,
    }]);
    assert_eq!(
        m.geo.silk_line_widths_mm,
        vec![0.01, 0.07],
        "both widths, sorted"
    );
    assert_eq!(
        m.geo.min_silk_line_mm,
        Some(0.01),
        "raw min is the artefact"
    );
    // Hotspots keep BOTH widths (per-value sampling), so the frontend's
    // artefact filter still leaves the real 0.07 stroke to mark.
    let mut widths: Vec<u32> = m
        .geo
        .silk_hotspots
        .iter()
        .map(|h| (h.v * 1000.0).round() as u32)
        .collect();
    widths.sort_unstable();
    widths.dedup();
    assert_eq!(
        widths,
        vec![10, 70],
        "hotspots keep the artefact AND the real width"
    );
    // The silk layer is Side::Top → every silk hotspot is tagged "top".
    assert!(
        m.geo.silk_hotspots.iter().all(|h| h.side == "top"),
        "silk hotspots are top-sided"
    );
}

#[test]
fn thin_trace_reported_via_conductor_not_region() {
    // One copper layer: a 1mm pad + a 0.1mm trace from it. The conductor model
    // must surface the thin trace; the region width-check must stay silent (no
    // zone fill present).
    const CU: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.0*%\n%ADD11C,0.1*%\n\
            D10*\nX0Y0D03*\nD11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";
    let inputs = vec![MetricLayerInput {
        role: Role::Copper,
        side: Side::Top,
        inner: false,
        plated: false,
        bytes: CU,
    }];
    let parsed = parse::parse_all(&inputs);
    let drills = parse::parse_all_drills(&inputs);
    let g = geo::geo_metrics(&inputs, &parsed, &drills);
    assert!(
        g.trace_count >= 1,
        "expected a conductor: {}",
        g.trace_count
    );
    assert!(
        g.thin_trace_conductors.iter().any(|h| h.v < 0.15),
        "thin conductor expected: {:?}",
        g.thin_trace_conductors
    );
    assert!(
        !g.copper_width_hotspots.iter().any(|h| h.v < 0.15),
        "region width-check must not flag the trace: {:?}",
        g.copper_width_hotspots
    );
    assert!(
        g.trace_total_length_mm > 4.0,
        "routed length: {}",
        g.trace_total_length_mm
    );
}

#[test]
fn annular_hotspot_side_attribution() {
    // Guards that annular_hotspots threads the copper side through to the
    // Hotspot.side field when the hole IS covered by a pad.
    //
    // Setup: one top copper layer with a 1 mm diameter circular pad (radius
    // 0.5 mm) flashed at (1.0, 1.0), and one PTH hole at (1.0, 1.0) with
    // drill diameter 0.3 mm (radius 0.15 mm) → annular ring = 0.35 mm.
    // The hole is covered by the top pad, so the hotspot must carry side="top".
    //
    // A second hole at (9.0, 9.0) has no pad on any layer → side="both".
    const CU_PAD_TOP: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX1000000Y1000000D03*\nM02*\n";
    // PTH drill: T1=0.3 mm at (1.0,1.0), T2=0.3 mm at (9.0,9.0) — no pad there.
    const PTH2: &[u8] = b"M48\nMETRIC,TZ\nT1C0.300\n%\nT1\nX1.0Y1.0\nX9.0Y9.0\nM30\n";
    let layers = vec![
        MetricLayerInput {
            role: Role::Copper,
            side: Side::Top,
            inner: false,
            plated: false,
            bytes: CU_PAD_TOP,
        },
        MetricLayerInput {
            role: Role::Drill,
            side: Side::Both,
            inner: false,
            plated: true,
            bytes: PTH2,
        },
    ];
    let m = board_metrics(&layers);
    assert_eq!(m.geo.annular_hotspots.len(), 2, "two plated holes");
    // Worst annular first: the bare hole (v=0) comes before the padded one.
    let sides: Vec<&str> = m
        .geo
        .annular_hotspots
        .iter()
        .map(|h| h.side.as_str())
        .collect();
    assert!(
        sides.contains(&"top"),
        "pad-covered hole must be attributed to 'top', got {:?}",
        sides
    );
    assert!(
        sides.contains(&"both"),
        "bare through-hole must be tagged 'both', got {:?}",
        sides
    );
}

#[test]
fn geo_detects_a_routed_slot() {
    const SLOT: &[u8] = b"M48\nMETRIC,TZ\nT1C1.000\n%\nT1\nX2.0Y2.0G85X6.0Y2.0\nM30\n";
    let m = board_metrics(&[MetricLayerInput {
        role: Role::Drill,
        side: Side::Both,
        inner: false,
        plated: false,
        bytes: SLOT,
    }]);
    assert_eq!(m.geo.slot_count, 1);
    assert!((m.geo.min_slot_width_mm.unwrap() - 1.0).abs() < 0.01);
}
