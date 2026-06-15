//! Full 3D board mesh, triangulated entirely in Rust.
//!
//! The 3D preview used to build all of its geometry on the JS main thread:
//! parse ~1 MB SVG strings, union/difference pad-and-pour fills with
//! `polygon-clipping`, stroke + centroid-cut tens of thousands of traces, then
//! `earcut`-triangulate the result — and finally spawn one `<mesh>` per drill
//! hole. On a dense board (a 4×12 keyboard: ~48 k copper traces, ~39 k silk
//! segments, 537 drills) that froze the UI for ~20 s and never cut the silk at
//! drill holes.
//!
//! This module moves ALL of that off the main thread: given the raw gerber bytes
//! for every layer plus their roles, it produces ready-to-upload triangle
//! buffers (positions / normals / indices, with the per-layer Z already baked
//! in). The frontend just wraps them in `BufferGeometry` — no booleans, no
//! triangulation, no per-hole meshes, no million-element `JSON.parse`.
//!
//! It builds on [`cuprum_gerber::geometry`] for the clean, drill-subtracted fill
//! polygons (`layer_polygons` / `mask_polygons`), and on [`cuprum_gerber::drill`]
//! for the holes. Surface layers are triangulated in parallel with `rayon`.
//!
//! Split into: [`emit`] (triangle-buffer primitives: earcut/faces/walls/barrels),
//! [`outline`] (Edge_Cuts stitching), [`build`] (substrate + surface-layer
//! assembly and the [`board_geometry`] entry point).

mod build;
mod emit;
pub mod export;
mod outline;

pub use build::board_geometry;
pub use outline::outline_info;

/// Default FR4 substrate thickness in mm, used when the project's panel stackup
/// is not configured. The real thickness is passed into [`board_geometry`].
pub const DEFAULT_FR4_THICK: f32 = 1.6;
/// Drill-bore cylinder facet count. Matches `geometry::CIRCLE_SEGS` (and
/// `DRILL_SEGS`) so the barrel nests exactly inside the copper/mask/FR4 hole
/// walls — mismatched counts left a stepped "square" edge in the bore.
const BARREL_SEGS: usize = 64;
/// Facets for circles used when difference-drilling the substrate faces.
/// Kept equal to `BARREL_SEGS` / `geometry::CIRCLE_SEGS` for clean nesting.
const DRILL_SEGS: usize = 64;
/// Endpoint-match tolerance (mm) when stitching the Edge_Cuts outline.
const STITCH_EPS: f64 = 1e-3;
/// Arc tessellation for the Edge_Cuts outline.
const EDGE_ARC_STEPS: usize = 48;

// Surface "kind" tags shared with the frontend (it picks the material).
pub const KIND_COPPER: u8 = 0;
pub const KIND_MASK: u8 = 1;
pub const KIND_SILK: u8 = 2;
pub const KIND_OTHER: u8 = 3;
pub const KIND_BARREL: u8 = 4;

/// The geometric role of a gerber layer (independent of `cuprum-project`'s
/// `LayerType`, so the core stays free of that dependency). The caller maps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Copper,
    Mask,
    Silk,
    Paste,
    Edge,
    Drill,
    Other,
}

/// Which face a layer lives on (drives the baked Z and normal direction).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Bottom,
    Both,
}

/// One input gerber layer: its stable key (used by the frontend to toggle
/// visibility), its role, its side, and the raw bytes.
pub struct LayerInput<'a> {
    pub key: String,
    pub role: Role,
    pub side: Side,
    pub bytes: &'a [u8],
}

/// A triangle buffer: interleaved-free positions/normals (xyz triples) and a
/// `u32` index list.
#[derive(Default, Clone)]
pub struct Buffer {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Buffer {
    fn vert_count(&self) -> u32 {
        (self.positions.len() / 3) as u32
    }

    fn push_vert(&mut self, x: f32, y: f32, z: f32, nx: f32, ny: f32, nz: f32) {
        self.positions.extend_from_slice(&[x, y, z]);
        self.normals.extend_from_slice(&[nx, ny, nz]);
    }
}

/// One triangulated surface layer, tagged by key + kind for the frontend.
pub struct LayerMesh {
    pub key: String,
    pub kind: u8,
    pub buffer: Buffer,
}

/// The complete board: the FR4 substrate, plus per-layer surface/barrel meshes.
/// Barrels are emitted as `KIND_BARREL` layer meshes keyed by their drill layer,
/// so the frontend can toggle a drill layer's holes like any other layer.
pub struct BoardMesh {
    pub substrate: Buffer,
    pub layers: Vec<LayerMesh>,
}

/// Vertical extent `(z_bottom, z_top)` of a surface layer's extruded slab, in mm.
/// Layers are real (exaggerated-for-visibility) slabs that sit flush on the
/// surface beneath them, so nothing reads as a floating plane: copper on the FR4,
/// mask wrapping the copper, silk on the mask, paste on the copper. Bottom-side
/// layers mirror below z=0. The small per-role base lift keeps coincident base
/// planes out of the depth buffer (no z-fighting against the FR4 face).
fn layer_z_range(role: Role, side: Side, thickness: f32) -> (f32, f32) {
    // (lift above the board surface, slab thickness) in mm.
    let (lift, thick) = match role {
        Role::Copper => (0.001, 0.035),
        Role::Mask => (0.003, 0.05),
        Role::Silk => (0.055, 0.012),
        Role::Paste => (0.036, 0.12),
        _ => (0.001, 0.03),
    };
    match side {
        Side::Bottom => (-(lift + thick), -lift),
        _ => (thickness + lift, thickness + lift + thick),
    }
}

#[cfg(test)]
mod tests {
    use super::emit::{emit_face, triangulate_poly};
    use super::outline::stitch;
    use super::*;
    use cuprum_gerber::geometry::Poly;

    const FLASH_PAD: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,4.0*%\nD10*\nX0Y0D03*\nM02*\n";
    // A simple rectangular Edge_Cuts outline (4 stroked sides), 10x10 mm.
    const EDGE_SQUARE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nX0100000Y0100000D01*\nX0Y0100000D01*\nX0Y0D01*\nM02*\n";

    #[test]
    fn copper_layer_triangulates_to_nonempty_buffer() {
        let layers = vec![LayerInput {
            key: "cu".into(),
            role: Role::Copper,
            side: Side::Top,
            bytes: FLASH_PAD,
        }];
        let board = board_geometry(&layers, DEFAULT_FR4_THICK);
        assert_eq!(board.layers.len(), 1);
        let m = &board.layers[0];
        assert_eq!(m.kind, KIND_COPPER);
        assert!(
            !m.buffer.positions.is_empty(),
            "copper buffer should have verts"
        );
        assert!(
            !m.buffer.indices.is_empty(),
            "copper buffer should have indices"
        );
        assert_eq!(
            m.buffer.positions.len(),
            m.buffer.normals.len(),
            "pos/normal parity"
        );
    }

    #[test]
    fn edge_outline_builds_substrate_faces_and_walls() {
        let layers = vec![LayerInput {
            key: "edge".into(),
            role: Role::Edge,
            side: Side::Both,
            bytes: EDGE_SQUARE,
        }];
        let board = board_geometry(&layers, DEFAULT_FR4_THICK);
        assert!(
            !board.substrate.positions.is_empty(),
            "substrate should be built from the outline"
        );
        assert!(!board.substrate.indices.is_empty());
    }

    #[test]
    fn drill_layer_emits_a_barrel_mesh() {
        // One PTH drill: a 0.3 mm hole at (5,5).
        const DRL: &[u8] = b"M48\nMETRIC,TZ\nT1C0.300\n%\nT1\nX5.0Y5.0\nM30\n";
        let layers = vec![LayerInput {
            key: "drl".into(),
            role: Role::Drill,
            side: Side::Both,
            bytes: DRL,
        }];
        let board = board_geometry(&layers, DEFAULT_FR4_THICK);
        let barrels: Vec<_> = board
            .layers
            .iter()
            .filter(|m| m.kind == KIND_BARREL)
            .collect();
        assert_eq!(
            barrels.len(),
            1,
            "expected one barrel mesh for the drill layer"
        );
        assert!(
            !barrels[0].buffer.positions.is_empty(),
            "barrel should have wall verts"
        );
    }

    #[test]
    fn two_faces_share_xy_and_reverse_winding() {
        // The substrate top/bottom optimization triangulates once and emits two
        // faces. Verify both faces have identical XY (differ only in Z) and the
        // bottom face's winding is reversed — i.e. bit-identical to two add_poly
        // calls with (z, +1) then (z, -1).
        let poly = Poly {
            outer: vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]],
            holes: vec![],
        };
        let (data, tris) = triangulate_poly(&poly).expect("square triangulates");
        let mut buf = Buffer::default();
        emit_face(&mut buf, &data, &tris, DEFAULT_FR4_THICK, 1.0);
        let vert_n = data.len() / 2;
        emit_face(&mut buf, &data, &tris, 0.0, -1.0);

        // Two faces' worth of verts and indices.
        assert_eq!(buf.positions.len(), vert_n * 3 * 2, "two faces of verts");
        assert_eq!(buf.indices.len(), tris.len() * 2, "two faces of tris");
        // Top verts at z=FR4_THICK, bottom at z=0, same XY.
        for i in 0..vert_n {
            let top = i * 3;
            let bot = (vert_n + i) * 3;
            assert_eq!(buf.positions[top], buf.positions[bot], "x matches");
            assert_eq!(buf.positions[top + 1], buf.positions[bot + 1], "y matches");
            assert_eq!(buf.positions[top + 2], DEFAULT_FR4_THICK, "top z");
            assert_eq!(buf.positions[bot + 2], 0.0, "bottom z");
        }
        // Bottom winding (a, c, b) is the reverse of top (a, b, c), offset by vert_n.
        let tri_n = tris.len() / 3;
        for t in 0..tri_n {
            let top = &buf.indices[t * 3..t * 3 + 3];
            let bot = &buf.indices[(tri_n + t) * 3..(tri_n + t) * 3 + 3];
            assert_eq!(bot[0], top[0] + vert_n as u32, "bottom a = top a + offset");
            assert_eq!(bot[1], top[2] + vert_n as u32, "bottom swaps b/c (c)");
            assert_eq!(bot[2], top[1] + vert_n as u32, "bottom swaps b/c (b)");
        }
    }

    #[test]
    fn thickness_drives_substrate_top_and_layer_z() {
        // Build with a non-default thickness; the substrate top face, walls and
        // surface-layer planes must follow it (not the hardcoded default).
        const T: f32 = 3.2;
        let layers = vec![
            LayerInput {
                key: "edge".into(),
                role: Role::Edge,
                side: Side::Both,
                bytes: EDGE_SQUARE,
            },
            LayerInput {
                key: "cu".into(),
                role: Role::Copper,
                side: Side::Top,
                bytes: FLASH_PAD,
            },
        ];
        let board = board_geometry(&layers, T);

        // Substrate has top-face verts at z=T (and bottom at 0); none at the default.
        let sub_z: Vec<f32> = board
            .substrate
            .positions
            .chunks_exact(3)
            .map(|c| c[2])
            .collect();
        assert!(sub_z.contains(&T), "substrate top face at custom z");
        assert!(
            !sub_z.contains(&DEFAULT_FR4_THICK),
            "no verts at the hardcoded default thickness"
        );
        assert_eq!(
            sub_z.iter().cloned().fold(f32::MIN, f32::max),
            T,
            "max z = thickness"
        );

        // Top copper is an extruded slab sitting just above the FR4 top: it has
        // both a bottom face (z0) and a top face (z1), and z0 follows thickness.
        let cu = board
            .layers
            .iter()
            .find(|m| m.kind == KIND_COPPER)
            .expect("copper");
        let (z0, z1) = layer_z_range(Role::Copper, Side::Top, T);
        let cu_zs: Vec<f32> = cu.buffer.positions.chunks_exact(3).map(|c| c[2]).collect();
        assert!(cu_zs.contains(&z1), "copper slab has a top face at z1={z1}");
        assert!(
            cu_zs.contains(&z0),
            "copper slab has a bottom face at z0={z0}"
        );
        assert!(
            z0 > T && z1 > z0,
            "copper slab sits above the FR4 top: {z0}..{z1}"
        );
    }

    #[test]
    fn board_geometry_emits_phase_spans_to_trace() {
        // A board exercising every phase: copper surface, edge outline, a drill.
        const DRL: &[u8] = b"M48\nMETRIC,TZ\nT1C0.300\n%\nT1\nX5.0Y5.0\nM30\n";
        let layers = vec![
            LayerInput {
                key: "cu".into(),
                role: Role::Copper,
                side: Side::Top,
                bytes: FLASH_PAD,
            },
            LayerInput {
                key: "edge".into(),
                role: Role::Edge,
                side: Side::Both,
                bytes: EDGE_SQUARE,
            },
            LayerInput {
                key: "drl".into(),
                role: Role::Drill,
                side: Side::Both,
                bytes: DRL,
            },
        ];

        let tmp = std::env::temp_dir().join(format!("cuprum-mesh-trace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = cuprum_trace::TraceConfig::Dir(tmp.clone());
        let board = cuprum_trace::run_with_config(&cfg, "mesh", &tmp, || {
            board_geometry(&layers, DEFAULT_FR4_THICK)
        });
        assert!(!board.substrate.positions.is_empty(), "board still built");

        let file = std::fs::read_dir(&tmp)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .expect("a mesh trace file was written");
        let body = std::fs::read_to_string(&file).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("trace is valid JSON");

        // Main-thread phase spans + substrate sub-phases.
        for name in [
            "collect_holes",
            "outline",
            "build_substrate",
            "drill_faces",
            "triangulate_faces",
            "triangulate_parallel",
            "barrels",
        ] {
            assert!(
                body.contains(name),
                "phase span `{name}` missing from trace"
            );
        }
        // Per-layer spans run on rayon workers; their presence proves the
        // `capture_dispatch`/`dh.run` propagation routes worker spans to the file.
        for name in ["build_surface_layer", "polygons", "triangulate"] {
            assert!(
                body.contains(name),
                "worker span `{name}` missing — dispatch propagation broken"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stitch_closes_a_square() {
        let segs = vec![
            ([0.0, 0.0], [10.0, 0.0]),
            ([10.0, 0.0], [10.0, 10.0]),
            ([10.0, 10.0], [0.0, 10.0]),
            ([0.0, 10.0], [0.0, 0.0]),
        ];
        let loops = stitch(segs);
        assert_eq!(loops.len(), 1, "four sides should stitch into one loop");
        assert_eq!(
            loops[0].0.len(),
            4,
            "square has 4 unique corners: {:?}",
            loops[0].0
        );
        assert!(loops[0].1, "a square should be detected as a closed loop");
    }
}
