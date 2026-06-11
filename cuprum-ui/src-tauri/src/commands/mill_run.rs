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
    /// Isolation rings as polygons for the preview overlay (panel space, Y up).
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

    let copper = cuprum_core::geometry::layer_polygons(&bytes, &holes)?;
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

/// One ring (`[f32; 2]` panel-space vertices) → a closed `MillPath` (`[f64; 2]`).
fn ring_to_path(ring: &[[f32; 2]]) -> MillPath {
    MillPath {
        points: ring.iter().map(|&[x, y]| [x as f64, y as f64]).collect(),
    }
}
