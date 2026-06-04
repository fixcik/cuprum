//! Unify the two CLI/GUI inputs — a folder/file of raw gerbers, or a `.cuprum`
//! container — into one in-memory `ResolvedDesign` that every tool consumes.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::document::container;
use crate::document::manifest::Stackup;
use crate::layer::{self, LayerType};

/// Where a resolved design came from.
#[derive(Debug, Clone)]
pub enum DesignSource {
    /// A single loose gerber/drill file.
    GerberFile(PathBuf),
    /// A directory of loose gerber/drill files.
    GerberDir(PathBuf),
    /// A `.cuprum` container.
    Project(PathBuf),
}

/// One layer: its name, classified type, and raw gerber/Excellon bytes.
#[derive(Debug, Clone)]
pub struct ResolvedLayer {
    pub rel: String,
    pub kind: LayerType,
    pub bytes: Vec<u8>,
}

/// A design reduced to the common shape the tools operate on.
#[derive(Debug, Clone)]
pub struct ResolvedDesign {
    pub source: DesignSource,
    pub layers: Vec<ResolvedLayer>,
    pub stackup: Stackup,
}

/// Options for resolution (forward-compat: side filter, design picker…).
#[derive(Debug, Clone, Default)]
pub struct ResolveOpts {}

/// Default FR4 stackup for raw gerber input. Mirrors the UI's default: 1oz / 1.6mm / double-sided.
fn default_stackup() -> Stackup {
    Stackup {
        copper_weight_oz: 1.0,
        substrate_thickness_mm: 1.6,
        double_sided: true,
    }
}

fn looks_like_gerber(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    matches!(ext, "gbr" | "drl" | "xln" | "nc" | "gko")
        || ext.starts_with("gt") // gtl/gts/gto/gtp
        || ext.starts_with("gb") // gbl/gbs/gbo/gbp
        || ext.starts_with("gm") // gm1/gm2/gm16 (mechanical/outline)
}

/// Resolve a path to a [`ResolvedDesign`].
///
/// Accepts a directory of raw gerber/drill files, a single gerber file, or a
/// `.cuprum` project container. All three reduce to the same in-memory shape.
pub fn resolve_design(path: &Path, _opts: &ResolveOpts) -> Result<ResolvedDesign> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if path.is_file() && (ext == "cuprum" || ext == "cu") {
        return resolve_project(path);
    }
    if path.is_file() {
        return resolve_single_file(path);
    }
    if path.is_dir() {
        return resolve_dir(path);
    }
    anyhow::bail!("not a gerber file/dir or .cuprum: {}", path.display());
}

fn resolve_single_file(path: &Path) -> Result<ResolvedDesign> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("layer")
        .to_string();
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(ResolvedDesign {
        source: DesignSource::GerberFile(path.to_path_buf()),
        layers: vec![ResolvedLayer {
            kind: layer::classify(&name),
            rel: name,
            bytes,
        }],
        stackup: default_stackup(),
    })
}

fn resolve_dir(dir: &Path) -> Result<ResolvedDesign> {
    let mut layers = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("read dir {}", dir.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !looks_like_gerber(&name) {
            continue;
        }
        let bytes = std::fs::read(entry.path())?;
        layers.push(ResolvedLayer {
            kind: layer::classify(&name),
            rel: name,
            bytes,
        });
    }
    anyhow::ensure!(
        !layers.is_empty(),
        "no gerber/Excellon files in {}",
        dir.display()
    );
    layers.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(ResolvedDesign {
        source: DesignSource::GerberDir(dir.to_path_buf()),
        layers,
        stackup: default_stackup(),
    })
}

fn resolve_project(container_path: &Path) -> Result<ResolvedDesign> {
    let manifest = container::read_manifest(container_path)?;
    let stackup = manifest.stackup.clone().unwrap_or_else(default_stackup);
    let mut layers = Vec::new();
    for design in &manifest.designs {
        for g in &design.gerbers {
            let bytes = container::read_entry(container_path, &g.path)
                .with_context(|| format!("read {} from container", g.path))?;
            layers.push(ResolvedLayer {
                rel: g.path.clone(),
                kind: g.layer_type,
                bytes,
            });
        }
    }
    anyhow::ensure!(
        !layers.is_empty(),
        "no gerbers in project {}",
        container_path.display()
    );
    Ok(ResolvedDesign {
        source: DesignSource::Project(container_path.to_path_buf()),
        layers,
        stackup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture_dir() -> std::path::PathBuf {
        // testdata/gerber/plaid/ contains a full KiCad gerber set
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/gerber/plaid")
    }

    #[test]
    fn resolves_a_gerber_directory() {
        let rd = resolve_design(&fixture_dir(), &ResolveOpts::default()).unwrap();
        assert!(matches!(rd.source, DesignSource::GerberDir(_)));
        assert!(!rd.layers.is_empty());
        assert!(rd.layers.iter().all(|l| !l.bytes.is_empty()));
        assert!(rd.stackup.double_sided); // raw input → default stackup
    }

    #[test]
    fn resolves_a_single_gerber_file() {
        let path = fixture_dir().join("plaid-F_Cu.gtl");
        let rd = resolve_design(&path, &ResolveOpts::default()).unwrap();
        assert!(matches!(rd.source, DesignSource::GerberFile(_)));
        assert_eq!(rd.layers.len(), 1);
        assert_eq!(rd.layers[0].kind, LayerType::TopCopper);
        assert!(!rd.layers[0].bytes.is_empty());
    }

    // .cuprum container resolution is covered by the CLI integration tests in a later task.
}
