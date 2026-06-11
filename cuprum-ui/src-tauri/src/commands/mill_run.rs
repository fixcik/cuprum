use crate::commands::error::{CmdError, CmdResult};

use cuprum_core::drilling::{CncParams, DatumCorner, MachineXY, Rect};
use cuprum_core::milling::{MillEstimate, MillParams, MillPath, MillPlanInput, MillProgram};

use super::machine::MachineState;
use super::render::{polys_to_dtos, HoleInput, PolyDto};

// ── Planning ─────────────────────────────────────────────────────────────────

/// Flat command input for `mill_plan`. The frontend sends the source gerber +
/// drill holes plus the isolation/cut parameters; the backend reads the bytes,
/// computes the copper boolean, derives the isolation toolpaths, and plans the
/// G-code. serde camelCase — the Tauri command's input shape.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPlanCmdInput {
    pub working_dir: String,
    pub gerber_rel: String,
    /// Drill holes to subtract from the copper before isolating (so rings don't
    /// run through plated holes). Same shape as `layer_polygons`' holes.
    pub holes: Vec<HoleInput>,
    /// Effective cut width of the bit (cylindrical: its diameter; V-bit:
    /// `vbit_cut_width`). Drives both the isolation offset and the gap check.
    pub cut_width_mm: f64,
    pub passes: u32,
    pub overlap: f64,
    pub climb: bool,
    pub datum: DatumCorner,
    pub panel_width_mm: f64,
    pub panel_height_mm: f64,
    /// X of the copper layer's bbox min corner (mm, absolute gerber space). The
    /// copper/holes arrive in absolute gerber coords (Y up); we subtract this and
    /// flip Y so paths/G-code/preview all live in panel space (Y down, origin
    /// top-left) — exactly the frame `machine_point` and the drill toolchain expect.
    pub origin_x_mm: f64,
    /// Y of the copper layer's bbox min corner (mm, absolute gerber space).
    pub origin_y_mm: f64,
    pub cnc: CncParams,
    pub cut_depth_mm: f64,
    #[serde(default)]
    pub depth_per_pass_mm: Option<f64>,
    pub feed_xy_mm_min: f64,
    pub plunge_mm_min: f64,
    pub keep_out_zones: Vec<Rect>,
    // `xy` lowercases to `Xy` under camelCase; the TS field is `startMachineXY`,
    // so rename explicitly. MachineXY (object), not a tuple (array).
    #[serde(rename = "startMachineXY")]
    pub start_machine_xy: Option<MachineXY>,
}

/// `mill_plan` result: the isolation toolpaths (for preview), the G-code program,
/// a motion-time estimate, and any copper gaps too narrow for this bit to isolate.
/// serde camelCase.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPlanCmdResult {
    /// Isolation rings as polygons for the preview overlay (panel space, Y down,
    /// origin 0,0 top-left). The canvas draws them straight over the `[0,0,W,H]`
    /// outline with no extra flip.
    pub paths: Vec<PolyDto>,
    pub program: MillProgram,
    pub estimate: MillEstimate,
    /// Copper gaps the bit would bridge (an electrical short). Empty when clean.
    pub violations: Vec<cuprum_core::dfm::Hotspot>,
}

/// Plan an isolation-milling run in the Rust core: copper boolean → isolation
/// toolpaths → G-code program + time estimate, plus the gap violations the bit
/// can't isolate. The GRBL kinematics are taken from the backend cache (kept
/// fresh by `$$` reads and console `$NNN=` snooping), so the estimate uses the
/// controller's real limits — any kinematics the frontend might send is ignored.
///
/// CPU-bound (boolean geometry + offset solver); run off the IPC thread via
/// `spawn_blocking` so the editor's re-plan on every preview tweak never blocks it.
#[tauri::command]
pub async fn mill_plan(
    state: tauri::State<'_, MachineState>,
    input: MillPlanCmdInput,
) -> CmdResult<MillPlanCmdResult> {
    let kinematics = state.kinematics();
    tauri::async_runtime::spawn_blocking(move || plan(input, kinematics))
        .await
        .map_err(CmdError::from)?
}

/// Pure planning body (off the IPC thread). Reads the gerber, builds the copper
/// boolean with holes subtracted, derives the isolation toolpaths, converts each
/// ring (outer + every hole) into a closed `MillPath`, then plans the program.
fn plan(
    input: MillPlanCmdInput,
    kinematics: cuprum_core::drilling::Kinematics,
) -> CmdResult<MillPlanCmdResult> {
    let bytes = crate::commands::project::read_workdir_file(&input.working_dir, &input.gerber_rel)?;
    let holes: Vec<cuprum_core::geometry::Hole> = input
        .holes
        .iter()
        .map(|h| cuprum_core::geometry::Hole {
            x: h.x,
            y: h.y,
            d: h.d,
        })
        .collect();

    // Copper (and the holes subtracted from it) come back in absolute gerber
    // coordinates, Y up. Normalise to panel space (origin-relative, Y down) BEFORE
    // isolating: the holes were already subtracted in the same absolute frame, so
    // every downstream consumer — isolation_paths, isolation_gap_violations, the
    // G-code (machine_point) and the preview canvas — sees one consistent panel
    // space (origin 0,0 top-left, Y down), identical to how the drill toolchain
    // feeds machine_point (panelDrill.ts projects holes to Y-down panel space too).
    let copper = cuprum_core::geometry::layer_polygons(&bytes, &holes)?;
    let copper = normalize_polys(
        copper,
        input.origin_x_mm,
        input.origin_y_mm,
        input.panel_height_mm,
    );
    let paths_poly = cuprum_core::geometry::isolation_paths(
        &copper,
        input.cut_width_mm,
        input.passes,
        input.overlap,
        input.climb,
    );

    // Each isolation ring is a closed cut contour: the outer ring and every hole
    // ring are separate paths (f32 geometry widened to f64 for the planner).
    let mill_paths: Vec<MillPath> = paths_poly
        .iter()
        .flat_map(|p| {
            std::iter::once(ring_to_path(&p.outer)).chain(p.holes.iter().map(|h| ring_to_path(h)))
        })
        .collect();

    let result = cuprum_core::milling::mill_plan(MillPlanInput {
        paths: mill_paths,
        datum: input.datum,
        panel_width_mm: input.panel_width_mm,
        panel_height_mm: input.panel_height_mm,
        cnc: input.cnc,
        params: MillParams {
            cut_depth_mm: input.cut_depth_mm,
            depth_per_pass_mm: input.depth_per_pass_mm,
            feed_xy_mm_min: input.feed_xy_mm_min,
            plunge_mm_min: input.plunge_mm_min,
            climb: input.climb,
        },
        kinematics,
        keep_out_zones: input.keep_out_zones,
        start_machine_xy: input.start_machine_xy,
    });

    let violations = cuprum_core::dfm::isolation_gap_violations(&copper, input.cut_width_mm);

    Ok(MillPlanCmdResult {
        paths: polys_to_dtos(paths_poly),
        program: result.program,
        estimate: result.estimate,
        violations,
    })
}

/// Normalise copper polygons from absolute gerber coords (Y up) to panel space:
/// origin-relative (subtract the bbox min corner) and Y flipped to point down
/// (origin 0,0 top-left). Per vertex `[x, y] → [x - origin_x, panel_height - (y -
/// origin_y)]`. This is the same projection `panelDrill.ts::projectHoleToPanel`
/// applies to drill holes (`dy_down = boardHeight - (y - originY)`), so mill paths
/// and drill holes share one panel-space frame; `machine_point` then applies its
/// datum-relative flip identically to both.
fn normalize_polys(
    polys: Vec<cuprum_core::geometry::Poly>,
    origin_x: f64,
    origin_y: f64,
    panel_height: f64,
) -> Vec<cuprum_core::geometry::Poly> {
    let ox = origin_x as f32;
    let oy = origin_y as f32;
    let ph = panel_height as f32;
    let map = |ring: Vec<[f32; 2]>| -> Vec<[f32; 2]> {
        ring.into_iter()
            .map(|[x, y]| [x - ox, ph - (y - oy)])
            .collect()
    };
    polys
        .into_iter()
        .map(|p| cuprum_core::geometry::Poly {
            outer: map(p.outer),
            holes: p.holes.into_iter().map(map).collect(),
        })
        .collect()
}

/// One ring (`[f32; 2]` panel-space vertices) → a closed `MillPath` (`[f64; 2]`).
fn ring_to_path(ring: &[[f32; 2]]) -> MillPath {
    MillPath {
        points: ring.iter().map(|&[x, y]| [x as f64, y as f64]).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_polys;
    use cuprum_core::geometry::Poly;

    /// A gerber at a non-zero origin must land in panel space (origin-relative,
    /// Y down). The absolute top-left corner of the bbox `(origin_x, origin_y + h)`
    /// must map to panel (0, 0); the absolute bottom-left `(origin_x, origin_y)`
    /// must map to panel (0, h). This is the drill-frame contract `machine_point`
    /// consumes — same as `panelDrill.ts::projectHoleToPanel`.
    #[test]
    fn normalize_offsets_origin_and_flips_y() {
        let origin_x = 10.0;
        let origin_y = 20.0;
        let h = 4.0; // panel height (board height)
                     // Absolute-coords rectangle spanning the bbox: x in [10, 13], y in [20, 24].
        let poly = Poly {
            outer: vec![
                [10.0, 20.0], // bottom-left  → panel (0, 4)
                [13.0, 20.0], // bottom-right → panel (3, 4)
                [13.0, 24.0], // top-right    → panel (3, 0)
                [10.0, 24.0], // top-left     → panel (0, 0)
            ],
            holes: vec![vec![[11.0, 21.0]]],
        };
        let out = normalize_polys(vec![poly], origin_x, origin_y, h);
        assert_eq!(out.len(), 1);
        let o = &out[0].outer;
        let eq =
            |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4;
        assert!(eq(o[0], [0.0, 4.0]), "bottom-left → (0,4): {:?}", o[0]);
        assert!(eq(o[1], [3.0, 4.0]), "bottom-right → (3,4): {:?}", o[1]);
        assert!(eq(o[2], [3.0, 0.0]), "top-right → (3,0): {:?}", o[2]);
        assert!(eq(o[3], [0.0, 0.0]), "top-left → (0,0): {:?}", o[3]);
        // Holes are mapped with the same projection.
        assert!(
            eq(out[0].holes[0][0], [1.0, 3.0]),
            "hole vertex: {:?}",
            out[0].holes[0][0]
        );
    }
}
