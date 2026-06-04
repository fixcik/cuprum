//! `cuprum info <input>` — summarise a gerber file/dir or a .cuprum project.

use std::path::Path;

use anyhow::Result;
use cuprum_project::resolve::{resolve_design, DesignSource, ResolveOpts};

pub fn run(input: &Path, json: bool) -> Result<()> {
    let rd = resolve_design(input, &ResolveOpts::default())?;
    if json {
        let layers: Vec<_> = rd
            .layers
            .iter()
            .map(|l| serde_json::json!({ "rel": l.rel, "type": l.kind, "bytes": l.bytes.len() }))
            .collect();
        let src = match &rd.source {
            DesignSource::GerberFile(p) => serde_json::json!({ "gerberFile": p }),
            DesignSource::GerberDir(p) => serde_json::json!({ "gerberDir": p }),
            DesignSource::Project(p) => serde_json::json!({ "project": p }),
        };
        println!(
            "{}",
            serde_json::json!({ "source": src, "stackup": rd.stackup, "layers": layers })
        );
    } else {
        match &rd.source {
            DesignSource::GerberFile(p) => println!("gerber file: {}", p.display()),
            DesignSource::GerberDir(p) => println!("gerber dir: {}", p.display()),
            DesignSource::Project(p) => println!("project: {}", p.display()),
        }
        println!(
            "stackup: {}oz / {}mm / {}",
            rd.stackup.copper_weight_oz,
            rd.stackup.substrate_thickness_mm,
            if rd.stackup.double_sided {
                "double-sided"
            } else {
                "single-sided"
            }
        );
        println!("layers ({}):", rd.layers.len());
        for l in &rd.layers {
            println!("  {:<32} {:?}  ({} B)", l.rel, l.kind, l.bytes.len());
        }
    }
    Ok(())
}
