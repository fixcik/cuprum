use crate::commands::error::{CmdError, CmdResult};

use cuprum_core::dfm::Hotspot;
use cuprum_core::drilling::{CncParams, DatumCorner, MachineXY, Rect};
use cuprum_core::geometry::Poly;
use cuprum_core::milling::{MillEstimate, MillParams, MillPath, MillPlanInput, MillProgram};

use super::machine::MachineState;
use super::render::{polys_to_dtos, HoleInput, PolyDto};

// ── Planning ─────────────────────────────────────────────────────────────────

/// One design referenced by the panel: its source gerber + drill holes plus the
/// gerber bbox origin and the design's extent (board width/height). The backend
/// isolates each design ONCE in board-local space (Y up), then projects the
/// resulting paths into panel space per placed instance. serde camelCase.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillDesignInput {
    pub gerber_rel: String,
    /// Drill holes to subtract from the copper (absolute gerber coords, same frame
    /// as `layer_polygons`) so rings don't run through plated holes.
    pub holes: Vec<HoleInput>,
    /// X of the design's copper bbox min corner (mm, absolute gerber space).
    pub origin_x_mm: f64,
    /// Y of the design's copper bbox min corner (mm, absolute gerber space).
    pub origin_y_mm: f64,
    /// Design extent width (mm) — the placed footprint width; used for the Y flip
    /// and the rotation centre when projecting into panel space.
    pub board_w_mm: f64,
    /// Design extent height (mm).
    pub board_h_mm: f64,
}

/// One placed instance: which design (by index into `designs`) and its pose on the
/// panel (top-left of the unrotated footprint + rotation about the centre).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillInstanceInput {
    pub design_index: usize,
    pub x_mm: f64,
    pub y_mm: f64,
    pub rotation_deg: f64,
}

/// Flat command input for `mill_plan` — panel-wide. The frontend sends every
/// referenced design (gerber + holes + origin + extent) and every placed instance;
/// the backend isolates each design once, projects its toolpaths into panel space
/// per instance, then plans one G-code program over the whole panel. serde
/// camelCase — the Tauri command's input shape.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MillPlanCmdInput {
    pub working_dir: String,
    /// Distinct designs referenced by the panel (deduped by the frontend).
    pub designs: Vec<MillDesignInput>,
    /// Placed instances; each points at a design via `design_index`.
    pub instances: Vec<MillInstanceInput>,
    pub panel_width_mm: f64,
    pub panel_height_mm: f64,
    /// Effective cut width of the bit (cylindrical: its diameter; V-bit:
    /// `vbit_cut_width`). Drives both the isolation offset and the gap check.
    pub cut_width_mm: f64,
    pub passes: u32,
    pub overlap: f64,
    pub climb: bool,
    pub datum: DatumCorner,
    pub cnc: CncParams,
    pub cut_depth_mm: f64,
    #[serde(default)]
    pub depth_per_pass_mm: Option<f64>,
    pub feed_xy_mm_min: f64,
    pub plunge_mm_min: f64,
    /// Keep-out zones in PANEL coordinates (now applicable — the plan is panel-wide).
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
    /// origin 0,0 top-left). The canvas draws them straight over the panel outline.
    pub paths: Vec<PolyDto>,
    pub program: MillProgram,
    pub estimate: MillEstimate,
    /// Copper gaps the bit would bridge (an electrical short), in panel space. Empty
    /// when clean.
    pub violations: Vec<Hotspot>,
}

/// Plan a panel-wide isolation-milling run in the Rust core: per design, copper
/// boolean → isolation toolpaths (board-local); per instance, project those paths
/// into panel space; then plan one G-code program + time estimate over the whole
/// panel, plus the gap violations the bit can't isolate. The GRBL kinematics are
/// taken from the backend cache (kept fresh by `$$` reads and console `$NNN=`
/// snooping), so the estimate uses the controller's real limits.
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

/// Per-design isolation result, in board-local space (Y up, origin at the design's
/// bbox min corner). Reused across every instance of that design.
struct DesignIso {
    /// Isolation rings (board-local, Y up).
    paths: Vec<Poly>,
    /// Gap violations (board-local, Y up).
    violations: Vec<Hotspot>,
    board_w: f64,
    board_h: f64,
}

/// Pure planning body (off the IPC thread). Isolates each design once in board-local
/// space, then projects its paths/violations into panel space for every placed
/// instance, accumulates a single panel-space path/violation set, and plans the
/// program over the whole panel.
fn plan(
    input: MillPlanCmdInput,
    kinematics: cuprum_core::drilling::Kinematics,
) -> CmdResult<MillPlanCmdResult> {
    // 1. Isolate each design ONCE (board-local, Y up).
    let mut design_iso: Vec<DesignIso> = Vec::with_capacity(input.designs.len());
    for d in &input.designs {
        let bytes = crate::commands::project::read_workdir_file(&input.working_dir, &d.gerber_rel)?;
        let holes: Vec<cuprum_core::geometry::Hole> = d
            .holes
            .iter()
            .map(|h| cuprum_core::geometry::Hole {
                x: h.x,
                y: h.y,
                d: h.d,
            })
            .collect();

        // Copper comes back in absolute gerber coords (Y up); shift to board-local
        // (origin at the bbox min corner) BUT keep Y up — the Y-flip into the panel
        // footprint happens during the per-instance projection (mirrors how
        // panelDrill.ts keeps holes Y-up board-local and flips in projectHoleToPanel).
        let copper = cuprum_core::geometry::layer_polygons(&bytes, &holes)?;
        let copper = translate_polys(copper, d.origin_x_mm, d.origin_y_mm);

        let paths = cuprum_core::geometry::isolation_paths(
            &copper,
            input.cut_width_mm,
            input.passes,
            input.overlap,
            input.climb,
        );
        let violations = cuprum_core::dfm::isolation_gap_violations(&copper, input.cut_width_mm);

        design_iso.push(DesignIso {
            paths,
            violations,
            board_w: d.board_w_mm,
            board_h: d.board_h_mm,
        });
    }

    // 2. Project each instance's design paths/violations into panel space (Y down),
    //    accumulating one panel-wide set.
    let mut panel_paths: Vec<Poly> = Vec::new();
    let mut panel_violations: Vec<Hotspot> = Vec::new();
    for inst in &input.instances {
        let Some(iso) = design_iso.get(inst.design_index) else {
            // Out-of-range index: skip rather than fail the whole plan.
            continue;
        };
        let bw = iso.board_w;
        let bh = iso.board_h;
        let proj_xy =
            |lx: f64, ly: f64| project(lx, ly, inst.x_mm, inst.y_mm, inst.rotation_deg, bw, bh);

        for p in &iso.paths {
            panel_paths.push(project_poly(p, &proj_xy));
        }
        for h in &iso.violations {
            let (ax, ay) = proj_xy(h.a[0] as f64, h.a[1] as f64);
            let (bx, by) = proj_xy(h.b[0] as f64, h.b[1] as f64);
            panel_violations.push(Hotspot {
                a: [ax as f32, ay as f32],
                b: [bx as f32, by as f32],
                v: h.v,
                side: h.side.clone(),
            });
        }
    }

    // 3. Each isolation ring is a closed cut contour (panel space, f64).
    let mill_paths: Vec<MillPath> = panel_paths
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

    Ok(MillPlanCmdResult {
        paths: polys_to_dtos(panel_paths),
        program: result.program,
        estimate: result.estimate,
        violations: panel_violations,
    })
}

/// Translate copper polygons from absolute gerber coords to board-local (subtract
/// the bbox min corner) — Y stays UP. Per vertex `[x, y] → [x - origin_x, y -
/// origin_y]`. The Y flip into the panel footprint is applied later, per instance,
/// by [`project`].
fn translate_polys(polys: Vec<Poly>, origin_x: f64, origin_y: f64) -> Vec<Poly> {
    let ox = origin_x as f32;
    let oy = origin_y as f32;
    let map = |ring: Vec<[f32; 2]>| -> Vec<[f32; 2]> {
        ring.into_iter().map(|[x, y]| [x - ox, y - oy]).collect()
    };
    polys
        .into_iter()
        .map(|p| Poly {
            outer: map(p.outer),
            holes: p.holes.into_iter().map(map).collect(),
        })
        .collect()
}

/// Project a board-local point (Y up, origin at the board's min corner) onto the
/// panel (Y down). This is the exact port of `panelDrill.ts::projectHoleToPanel`:
/// flip Y into the footprint, then rotate about the footprint centre. Keeping one
/// projection for both drill holes and mill paths guarantees a placed board's
/// toolpaths land exactly on its drawn footprint, with no double Y-flip.
fn project(lx: f64, ly: f64, ix: f64, iy: f64, rot_deg: f64, bw: f64, bh: f64) -> (f64, f64) {
    let ux = ix + lx;
    // Gerber Y-up → panel Y-down footprint: local y=0 (board bottom) maps to the
    // footprint bottom edge (iy + bh).
    let uy = iy + (bh - ly);
    let cx = ix + bw / 2.0;
    let cy = iy + bh / 2.0;
    rotate_around(ux, uy, cx, cy, rot_deg)
}

/// Rotate point (px, py) about centre (cx, cy) by `rotation_deg` (degrees, CCW in
/// the panel's Y-down space). Port of `panelPlacement.ts::rotatePointAroundCenter`.
fn rotate_around(px: f64, py: f64, cx: f64, cy: f64, rotation_deg: f64) -> (f64, f64) {
    let rad = rotation_deg * std::f64::consts::PI / 180.0;
    let cos = rad.cos();
    let sin = rad.sin();
    (
        cx + (px - cx) * cos - (py - cy) * sin,
        cy + (px - cx) * sin + (py - cy) * cos,
    )
}

/// Apply a panel projection to every ring of a board-local poly (`f32` → projected
/// `f32`).
fn project_poly(p: &Poly, proj: &impl Fn(f64, f64) -> (f64, f64)) -> Poly {
    let map = |ring: &[[f32; 2]]| -> Vec<[f32; 2]> {
        ring.iter()
            .map(|&[x, y]| {
                let (px, py) = proj(x as f64, y as f64);
                [px as f32, py as f32]
            })
            .collect()
    };
    Poly {
        outer: map(&p.outer),
        holes: p.holes.iter().map(|h| map(h)).collect(),
    }
}

/// One ring (`[f32; 2]` panel-space vertices) → a closed `MillPath` (`[f64; 2]`).
fn ring_to_path(ring: &[[f32; 2]]) -> MillPath {
    MillPath {
        points: ring.iter().map(|&[x, y]| [x as f64, y as f64]).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::{project, translate_polys};
    use cuprum_core::geometry::Poly;

    /// translate_polys subtracts the bbox origin but keeps Y up (no flip here).
    #[test]
    fn translate_offsets_origin_only() {
        let poly = Poly {
            outer: vec![[10.0, 20.0], [13.0, 24.0]],
            holes: vec![vec![[11.0, 21.0]]],
        };
        let out = translate_polys(vec![poly], 10.0, 20.0);
        let o = &out[0].outer;
        let eq =
            |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4;
        assert!(eq(o[0], [0.0, 0.0]), "min corner → (0,0): {:?}", o[0]);
        assert!(eq(o[1], [3.0, 4.0]), "max corner → (3,4): {:?}", o[1]);
        assert!(
            eq(out[0].holes[0][0], [1.0, 1.0]),
            "hole: {:?}",
            out[0].holes[0][0]
        );
    }

    /// With rotation 0, projection only flips Y into the footprint. A board-local
    /// vertex at the board TOP `(0, h)` (Y up) must land at the footprint TOP-LEFT
    /// `(inst.x, inst.y)` in panel Y-down space; the board BOTTOM `(0, 0)` lands at
    /// the footprint bottom-left `(inst.x, inst.y + h)`. This is the same Y-flip
    /// panelDrill.ts::projectHoleToPanel applies — no double flip.
    #[test]
    fn project_no_rotation_flips_y_into_footprint() {
        let (bw, bh) = (3.0, 4.0);
        let (ix, iy) = (10.0, 20.0);
        let eq =
            |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9;
        // board top (Y up, ly = h) → panel top of footprint (iy)
        assert!(eq(project(0.0, bh, ix, iy, 0.0, bw, bh), (10.0, 20.0)));
        // board bottom (ly = 0) → panel bottom of footprint (iy + h)
        assert!(eq(project(0.0, 0.0, ix, iy, 0.0, bw, bh), (10.0, 24.0)));
        // board right edge carries through X
        assert!(eq(project(bw, bh, ix, iy, 0.0, bw, bh), (13.0, 20.0)));
    }

    /// Rotation is about the footprint CENTRE. A 90° turn of the footprint top-left
    /// (panel (ix, iy)) about centre (ix + bw/2, iy + bh/2) must match the manual
    /// CCW-in-Y-down rotation. Guards the rotation-centre port.
    #[test]
    fn project_rotation_about_center() {
        let (bw, bh) = (3.0, 4.0);
        let (ix, iy) = (10.0, 20.0);
        // Footprint top-left in panel space is (ix, iy); reach it from board-local
        // (lx=0, ly=h). Rotate 90° about centre.
        let got = project(0.0, bh, ix, iy, 90.0, bw, bh);
        // Manual: pre-rotation point (ix, iy) = (10, 20); centre = (11.5, 22).
        // 90°: cos=0, sin=1 → (cx - (py-cy), cy + (px-cx))
        let (cx, cy) = (ix + bw / 2.0, iy + bh / 2.0);
        let (px, py) = (ix, iy);
        let want = (cx - (py - cy), cy + (px - cx));
        assert!(
            (got.0 - want.0).abs() < 1e-9 && (got.1 - want.1).abs() < 1e-9,
            "rotated {:?} vs {:?}",
            got,
            want
        );
    }
}
