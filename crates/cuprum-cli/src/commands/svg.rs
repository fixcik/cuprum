//! `cuprum svg <input> [-o out.svg]` — composite SVG (top side, default colours).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use cuprum_core::preview::compose_svg;
use cuprum_core::svg::render_layer_svg;
use cuprum_project::layer::LayerType;
use cuprum_project::resolve::{resolve_design, ResolveOpts};

use crate::commands::render::default_out;

fn type_key(t: LayerType) -> String {
    serde_json::to_value(t)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

pub fn run(input: &Path, out: Option<PathBuf>) -> Result<()> {
    let rd = resolve_design(input, &ResolveOpts::default())?;
    // Parse each non-drill layer to its SVG geometry; skip layers that fail to
    // parse (blank silk/paste is common) so one bad layer doesn't abort the doc.
    let mut composed = Vec::new();
    for l in rd.layers.iter().filter(|l| l.kind != LayerType::Drill) {
        match render_layer_svg(&l.bytes, &type_key(l.kind)) {
            Ok(g) => composed.push((type_key(l.kind), g)),
            Err(_) => continue,
        }
    }
    anyhow::ensure!(
        !composed.is_empty(),
        "no renderable layers in {}",
        input.display()
    );
    // v1: no rounded board clip (rectangular bbox). Rounded clip = follow-up.
    let doc = compose_svg(&composed, &HashMap::new(), None);
    let out = out.unwrap_or_else(|| default_out(input, "svg"));
    std::fs::write(&out, doc.as_bytes())?;
    println!("wrote {}", out.display());
    Ok(())
}
