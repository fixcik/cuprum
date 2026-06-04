//! Export a `BoardMesh` to portable 3D formats (STL / OBJ / glTF-glb).

use std::fmt::Write as _;

use crate::{BoardMesh, Buffer};

/// `(buffer, rgb 0..1)` for every renderable buffer: FR4 substrate + each layer.
fn buffers(mesh: &BoardMesh) -> Vec<(&Buffer, [f32; 3])> {
    let mut v: Vec<(&Buffer, [f32; 3])> = vec![(&mesh.substrate, [0.35, 0.31, 0.17])];
    for l in &mesh.layers {
        v.push((&l.buffer, color_for_kind(l.kind)));
    }
    v
}

/// Layer-kind → display rgb (0..1). v1: single copper-ish tint.
fn color_for_kind(_kind: u8) -> [f32; 3] {
    [0.72, 0.45, 0.20]
}

/// Binary STL: 80-byte header + u32 tri count + 50 bytes/triangle. One solid, no colour.
pub fn to_stl(mesh: &BoardMesh) -> Vec<u8> {
    let mut tris = 0u32;
    for (b, _) in buffers(mesh) {
        tris += (b.indices.len() / 3) as u32;
    }
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&tris.to_le_bytes());
    for (b, _) in buffers(mesh) {
        for t in b.indices.chunks_exact(3) {
            let p = |i: u32| {
                let i = i as usize * 3;
                [b.positions[i], b.positions[i + 1], b.positions[i + 2]]
            };
            let (a, bb, c) = (p(t[0]), p(t[1]), p(t[2]));
            let n = face_normal(a, bb, c);
            for v in [n, a, bb, c] {
                for f in v {
                    out.extend_from_slice(&f.to_le_bytes());
                }
            }
            out.extend_from_slice(&[0u8, 0u8]);
        }
    }
    out
}

fn face_normal(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-9);
    [n[0] / len, n[1] / len, n[2] / len]
}

/// OBJ (+ MTL): one group/material per buffer (colour via .mtl). Returns `(obj, mtl)`.
pub fn to_obj(mesh: &BoardMesh, mtl_name: &str) -> (String, String) {
    let mut obj = String::new();
    let mut mtl = String::new();
    let _ = writeln!(obj, "mtllib {mtl_name}");
    let mut base = 1usize;
    for (i, (b, rgb)) in buffers(mesh).into_iter().enumerate() {
        let mat = format!("mat{i}");
        let _ = writeln!(mtl, "newmtl {mat}\nKd {} {} {}", rgb[0], rgb[1], rgb[2]);
        let _ = writeln!(obj, "o part{i}\nusemtl {mat}");
        for v in b.positions.chunks_exact(3) {
            let _ = writeln!(obj, "v {} {} {}", v[0], v[1], v[2]);
        }
        for t in b.indices.chunks_exact(3) {
            let _ = writeln!(
                obj,
                "f {} {} {}",
                base + t[0] as usize,
                base + t[1] as usize,
                base + t[2] as usize
            );
        }
        base += b.positions.len() / 3;
    }
    (obj, mtl)
}

/// glTF 2.0 binary container (.glb).
///
/// Builds one BIN buffer (POSITION + NORMAL + indices per renderable layer),
/// writes the JSON chunk with materials/meshes/nodes/scene, and packs everything
/// into a conformant .glb file.
pub fn to_glb(mesh: &BoardMesh) -> Vec<u8> {
    // Collect only non-empty buffers (count=0 accessors are invalid in glTF).
    let bufs: Vec<(&Buffer, [f32; 3])> = buffers(mesh)
        .into_iter()
        .filter(|(b, _)| !b.positions.is_empty() && !b.indices.is_empty())
        .collect();

    if bufs.is_empty() {
        return build_empty_glb();
    }

    // --- BIN chunk assembly --------------------------------------------------
    // Per non-empty buffer: POSITION bytes | NORMAL bytes | INDEX bytes
    struct Region {
        pos_offset: u32,
        pos_len: u32,
        nrm_offset: u32,
        nrm_len: u32,
        idx_offset: u32,
        idx_len: u32,
        vert_count: u32,
        tri_count: u32,
        pos_min: [f32; 3],
        pos_max: [f32; 3],
    }

    let mut bin: Vec<u8> = Vec::new();
    let mut regions: Vec<Region> = Vec::with_capacity(bufs.len());

    for (b, _) in &bufs {
        let pos_offset = bin.len() as u32;
        for &f in &b.positions {
            bin.extend_from_slice(&f.to_le_bytes());
        }
        let pos_len = bin.len() as u32 - pos_offset;

        let nrm_offset = bin.len() as u32;
        for &f in &b.normals {
            bin.extend_from_slice(&f.to_le_bytes());
        }
        let nrm_len = bin.len() as u32 - nrm_offset;

        let idx_offset = bin.len() as u32;
        for &i in &b.indices {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        let idx_len = bin.len() as u32 - idx_offset;

        let vert_count = (b.positions.len() / 3) as u32;
        let tri_count = (b.indices.len() / 3) as u32;

        // Compute POSITION min/max for the accessor.
        let mut pos_min = [f32::INFINITY; 3];
        let mut pos_max = [f32::NEG_INFINITY; 3];
        for chunk in b.positions.chunks_exact(3) {
            for k in 0..3 {
                if chunk[k] < pos_min[k] {
                    pos_min[k] = chunk[k];
                }
                if chunk[k] > pos_max[k] {
                    pos_max[k] = chunk[k];
                }
            }
        }

        regions.push(Region {
            pos_offset,
            pos_len,
            nrm_offset,
            nrm_len,
            idx_offset,
            idx_len,
            vert_count,
            tri_count,
            pos_min,
            pos_max,
        });
    }

    // Pad BIN to multiple of 4 with zeros.
    while !bin.len().is_multiple_of(4) {
        bin.push(0x00);
    }
    let bin_padded_len = bin.len() as u32;

    // --- JSON chunk assembly -------------------------------------------------
    use serde_json::{json, Value};

    // One glTF buffer covering the whole BIN.
    let gltf_buffers = json!([{ "byteLength": bin_padded_len }]);

    // BufferViews: for each region, 3 views (POSITION, NORMAL, INDEX).
    // target 34962 = ARRAY_BUFFER, 34963 = ELEMENT_ARRAY_BUFFER.
    let mut buffer_views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let mut materials: Vec<Value> = Vec::new();
    let mut meshes: Vec<Value> = Vec::new();
    let mut nodes: Vec<Value> = Vec::new();

    for (idx, (reg, (_, rgb))) in regions.iter().zip(bufs.iter()).enumerate() {
        // --- buffer views ---
        let bv_pos = buffer_views.len() as u32;
        buffer_views.push(json!({
            "buffer": 0,
            "byteOffset": reg.pos_offset,
            "byteLength": reg.pos_len,
            "target": 34962
        }));
        let bv_nrm = buffer_views.len() as u32;
        buffer_views.push(json!({
            "buffer": 0,
            "byteOffset": reg.nrm_offset,
            "byteLength": reg.nrm_len,
            "target": 34962
        }));
        let bv_idx = buffer_views.len() as u32;
        buffer_views.push(json!({
            "buffer": 0,
            "byteOffset": reg.idx_offset,
            "byteLength": reg.idx_len,
            "target": 34963
        }));

        // --- accessors ---
        let acc_pos = accessors.len() as u32;
        accessors.push(json!({
            "bufferView": bv_pos,
            "componentType": 5126,   // FLOAT
            "count": reg.vert_count,
            "type": "VEC3",
            "min": reg.pos_min,
            "max": reg.pos_max
        }));
        let acc_nrm = accessors.len() as u32;
        accessors.push(json!({
            "bufferView": bv_nrm,
            "componentType": 5126,
            "count": reg.vert_count,
            "type": "VEC3"
        }));
        let acc_idx = accessors.len() as u32;
        accessors.push(json!({
            "bufferView": bv_idx,
            "componentType": 5125,   // UNSIGNED_INT
            "count": reg.tri_count * 3,
            "type": "SCALAR"
        }));

        // --- material ---
        let mat_idx = idx as u32;
        materials.push(json!({
            "pbrMetallicRoughness": {
                "baseColorFactor": [rgb[0], rgb[1], rgb[2], 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.8
            }
        }));

        // --- mesh ---
        let mesh_idx = idx as u32;
        meshes.push(json!({
            "primitives": [{
                "attributes": {
                    "POSITION": acc_pos,
                    "NORMAL": acc_nrm
                },
                "indices": acc_idx,
                "material": mat_idx,
                "mode": 4
            }]
        }));

        // --- node ---
        nodes.push(json!({ "mesh": mesh_idx }));
    }

    let node_indices: Vec<u32> = (0..nodes.len() as u32).collect();
    let gltf_json = json!({
        "asset": { "version": "2.0", "generator": "cuprum-mesh" },
        "scene": 0,
        "scenes": [{ "nodes": node_indices }],
        "nodes": nodes,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": gltf_buffers,
        "materials": materials
    });

    let json_bytes = serde_json::to_vec(&gltf_json).expect("json serialization is infallible");

    // Pad JSON to multiple of 4 with spaces (0x20).
    let json_padded_len = (json_bytes.len() + 3) & !3;
    let mut json_padded = json_bytes;
    while !json_padded.len().is_multiple_of(4) {
        json_padded.push(0x20);
    }

    // --- .glb container assembly ---------------------------------------------
    // 12-byte header + JSON chunk + BIN chunk
    // JSON chunk: 4 (len) + 4 (type) + json_padded_len
    // BIN chunk:  4 (len) + 4 (type) + bin_padded_len
    let json_chunk_len = 8 + json_padded_len as u32;
    let bin_chunk_len = 8 + bin_padded_len;
    let total_len = 12 + json_chunk_len + bin_chunk_len;

    let mut glb: Vec<u8> = Vec::with_capacity(total_len as usize);

    // Header
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes()); // version = 2
    glb.extend_from_slice(&total_len.to_le_bytes());

    // JSON chunk
    glb.extend_from_slice(&(json_padded.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_padded);

    // BIN chunk
    glb.extend_from_slice(&bin_padded_len.to_le_bytes());
    glb.extend_from_slice(&[0x42, 0x49, 0x4E, 0x00]); // BIN\0
    glb.extend_from_slice(&bin);

    glb
}

/// Minimal valid glb with an empty scene (used when every buffer is empty).
fn build_empty_glb() -> Vec<u8> {
    use serde_json::json;
    let gltf_json = json!({
        "asset": { "version": "2.0", "generator": "cuprum-mesh" },
        "scene": 0,
        "scenes": [{ "nodes": [] }]
    });
    let json_bytes = serde_json::to_vec(&gltf_json).expect("json serialization is infallible");
    let mut json_padded = json_bytes;
    while !json_padded.len().is_multiple_of(4) {
        json_padded.push(0x20);
    }
    let json_chunk_payload_len = json_padded.len() as u32;
    let total_len = 12 + 8 + json_chunk_payload_len;

    let mut glb: Vec<u8> = Vec::with_capacity(total_len as usize);
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&total_len.to_le_bytes());
    glb.extend_from_slice(&json_chunk_payload_len.to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_padded);
    glb
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{board_geometry, LayerInput, Role, Side};

    fn tiny_mesh() -> crate::BoardMesh {
        // One small flashed copper pad + edge outline so board_geometry
        // produces both surface triangles and a substrate. A 4 mm pad on a
        // 10x10 mm board is the same fixture used in lib.rs tests.
        let gbr: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,4.0*%\nD10*\nX0Y0D03*\nM02*\n";
        let edge: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nX0100000Y0100000D01*\nX0Y0100000D01*\nX0Y0D01*\nM02*\n";
        let inputs = vec![
            LayerInput {
                key: "f".into(),
                role: Role::Copper,
                side: Side::Top,
                bytes: gbr,
            },
            LayerInput {
                key: "edge".into(),
                role: Role::Edge,
                side: Side::Both,
                bytes: edge,
            },
        ];
        board_geometry(&inputs, 1.6)
    }

    #[test]
    fn stl_has_header_and_triangles() {
        let stl = to_stl(&tiny_mesh());
        assert!(stl.len() > 84);
        let count = u32::from_le_bytes(stl[80..84].try_into().unwrap());
        assert!(count > 0, "at least one triangle");
        assert_eq!(stl.len(), 84 + count as usize * 50, "50 bytes per triangle");
    }

    #[test]
    fn obj_has_verts_and_faces() {
        let (obj, mtl) = to_obj(&tiny_mesh(), "b.mtl");
        assert!(obj.contains("\nv "));
        assert!(obj.contains("\nf "));
        assert!(mtl.contains("newmtl"));
    }

    #[test]
    fn glb_has_magic_and_chunks() {
        let glb = to_glb(&tiny_mesh());
        assert_eq!(&glb[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2);
        let total = u32::from_le_bytes(glb[8..12].try_into().unwrap());
        assert_eq!(
            total as usize,
            glb.len(),
            "header total length == file length"
        );
    }

    #[test]
    fn glb_json_chunk_is_valid_json() {
        let glb = to_glb(&tiny_mesh());
        // JSON chunk payload starts at byte 20 (12 header + 4 len + 4 type).
        let json_chunk_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        let json_bytes = &glb[20..20 + json_chunk_len];
        // Strip trailing padding spaces.
        let trimmed = json_bytes.iter().rposition(|&b| b != 0x20).unwrap_or(0);
        let json_str = std::str::from_utf8(&json_bytes[..=trimmed]).unwrap();
        serde_json::from_str::<serde_json::Value>(json_str)
            .expect("glb JSON chunk should parse as valid JSON");
    }
}
