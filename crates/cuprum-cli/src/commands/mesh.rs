//! `cuprum 3d <input> [-o out.glb] [--format gltf|stl|obj]` — export the board mesh.

use std::path::{Path, PathBuf};

use anyhow::Result;
use cuprum_core::mesh::{board_geometry, export, LayerInput};
use cuprum_project::layer::role_side;
use cuprum_project::resolve::{resolve_design, ResolveOpts};

use crate::commands::render::default_out;

#[derive(Clone, Copy)]
pub enum Format {
    Gltf,
    Stl,
    Obj,
}

impl Format {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "gltf" | "glb" => Some(Format::Gltf),
            "stl" => Some(Format::Stl),
            "obj" => Some(Format::Obj),
            _ => None,
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Format::Gltf => "glb",
            Format::Stl => "stl",
            Format::Obj => "obj",
        }
    }
}

pub fn run(input: &Path, out: Option<PathBuf>, format: Option<String>) -> Result<()> {
    let rd = resolve_design(input, &ResolveOpts::default())?;
    // Format: explicit flag → out extension → default glb.
    let fmt = match format.as_deref() {
        Some(s) => Format::parse(s).ok_or_else(|| anyhow::anyhow!("unknown --format {s}"))?,
        None => out
            .as_ref()
            .and_then(|p| p.extension())
            .and_then(|e| e.to_str())
            .and_then(Format::parse)
            .unwrap_or(Format::Gltf),
    };
    // Build mesh inputs (borrow bytes). board_geometry handles all roles incl. drill barrels.
    let inputs: Vec<LayerInput> = rd
        .layers
        .iter()
        .map(|l| {
            let (role, side) = role_side(l.kind);
            LayerInput {
                key: l.rel.clone(),
                role,
                side,
                bytes: &l.bytes,
            }
        })
        .collect();
    let mesh = board_geometry(&inputs, rd.stackup.substrate_thickness_mm);
    let out = out.unwrap_or_else(|| default_out(input, fmt.ext()));
    match fmt {
        Format::Gltf => std::fs::write(&out, export::to_glb(&mesh))?,
        Format::Stl => std::fs::write(&out, export::to_stl(&mesh))?,
        Format::Obj => {
            let mtl_path = out.with_extension("mtl");
            let mtl_name = mtl_path
                .file_name()
                .ok_or_else(|| anyhow::anyhow!("cannot derive MTL filename from {:?}", mtl_path))?
                .to_string_lossy()
                .into_owned();
            let (obj, mtl) = export::to_obj(&mesh, &mtl_name);
            std::fs::write(&out, obj)?;
            std::fs::write(&mtl_path, mtl)?;
        }
    }
    println!("wrote {}", out.display());
    Ok(())
}
