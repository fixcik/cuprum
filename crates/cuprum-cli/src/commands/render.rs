//! `cuprum render <input> [-o out.png]` — composite colour PNG (top side).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use cuprum_core::preview::{render_design_preview, PreviewLayer};
use cuprum_project::layer::LayerType;
use cuprum_project::resolve::{resolve_design, ResolveOpts};

use crate::commands::type_key;

pub fn run(input: &Path, out: Option<PathBuf>, max_px: u32) -> Result<()> {
    let rd = resolve_design(input, &ResolveOpts::default())?;
    // Drill layers carry no surface; the composite has no holes (matches the card).
    let layers: Vec<PreviewLayer> = rd
        .layers
        .iter()
        .filter(|l| l.kind != LayerType::Drill)
        .map(|l| PreviewLayer {
            layer_type: type_key(l.kind),
            bytes: l.bytes.clone(),
        })
        .collect();
    // No project artifacts dir for raw gerbers → cache into a throwaway temp dir.
    let tmp = std::env::temp_dir().join("cuprum-cli-render");
    std::fs::create_dir_all(&tmp).ok();
    let png = render_design_preview(&tmp, &layers, &HashMap::new(), max_px)?;
    let out = out.unwrap_or_else(|| default_out(input, "png"));
    std::fs::write(&out, &png)?;
    println!(
        "wrote {} ({:.1} KiB)",
        out.display(),
        png.len() as f64 / 1024.0
    );
    Ok(())
}

/// `<input-stem>.<ext>` (dir → its own name). Public — reused by other commands.
pub fn default_out(input: &Path, ext: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("board");
    PathBuf::from(format!("{stem}.{ext}"))
}
