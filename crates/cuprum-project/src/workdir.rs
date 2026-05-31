//! Per-open working directory: a `.cuprum` container is extracted here on open,
//! edited as loose files, and packed back on save. Reads/renders hit plain files
//! (no per-layer ZIP extraction) and intermediate edits are cheap.

use std::fs;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::container::{self, MANIFEST_NAME, PANEL_NAME};
use crate::manifest::Manifest;
use crate::panel::PanelDoc;

/// Marker file at the working-dir root, naming the source container and the
/// owning process so orphans can be found after a crash.
pub const SESSION_MARKER: &str = ".cuprum-session.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMarker {
    pub source_path: String,
    pub pid: u32,
    pub opened_at: i64,
}

pub fn write_marker(workdir: &Path, marker: &SessionMarker) -> Result<()> {
    fs::write(
        workdir.join(SESSION_MARKER),
        serde_json::to_vec_pretty(marker)?,
    )?;
    Ok(())
}

pub fn read_marker(workdir: &Path) -> Result<SessionMarker> {
    let bytes = fs::read(workdir.join(SESSION_MARKER))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Read the live manifest from the working dir.
pub fn read_manifest(workdir: &Path) -> Result<Manifest> {
    let bytes = fs::read(workdir.join(MANIFEST_NAME))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Overwrite the working dir's manifest.json (called on every doc mutation).
pub fn write_manifest(workdir: &Path, manifest: &Manifest) -> Result<()> {
    fs::write(
        workdir.join(MANIFEST_NAME),
        serde_json::to_vec_pretty(manifest)?,
    )?;
    Ok(())
}

/// Read panel.json from the working dir, or `None` if absent.
pub fn read_panel(workdir: &Path) -> Result<Option<PanelDoc>> {
    let path = workdir.join(PANEL_NAME);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

pub fn write_panel(workdir: &Path, panel: &PanelDoc) -> Result<()> {
    fs::write(workdir.join(PANEL_NAME), serde_json::to_vec_pretty(panel)?)?;
    Ok(())
}

use std::io::Read;

/// Extract every entry of `container` into a fresh `workdir`, then write the
/// session marker. `workdir` must not already exist.
pub fn extract(container: &Path, workdir: &Path, marker: &SessionMarker) -> Result<()> {
    if workdir.exists() {
        anyhow::bail!("working dir already exists: {}", workdir.display());
    }
    fs::create_dir_all(workdir)?;
    let file = fs::File::open(container)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        // Skip entries with unsafe (absolute / `..`) paths.
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out = workdir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        fs::write(&out, &buf)?;
    }
    write_marker(workdir, marker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cuprum-wd-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_round_trips() {
        let wd = scratch("marker");
        let m = SessionMarker {
            source_path: "/tmp/x.cu".into(),
            pid: 4242,
            opened_at: 1000,
        };
        write_marker(&wd, &m).unwrap();
        assert_eq!(read_marker(&wd).unwrap(), m);
        std::fs::remove_dir_all(&wd).ok();
    }

    #[test]
    fn manifest_and_panel_round_trip_loose() {
        use crate::manifest::Manifest;
        use crate::panel::PanelDoc;
        let wd = scratch("loose");

        let mut m = Manifest::new("demo");
        m.description = "hi".into();
        write_manifest(&wd, &m).unwrap();
        assert_eq!(read_manifest(&wd).unwrap(), m);

        // No panel.json yet -> None.
        assert!(read_panel(&wd).unwrap().is_none());
        let p = PanelDoc::new(120.0, 80.0);
        write_panel(&wd, &p).unwrap();
        assert_eq!(read_panel(&wd).unwrap(), Some(p));

        std::fs::remove_dir_all(&wd).ok();
    }

    #[test]
    fn extract_lays_out_loose_files() {
        use crate::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let root = scratch("extract");
        let cuprum = root.join("p.cu");

        let mut m = Manifest::new("demo");
        m.designs.push(Design {
            id: "design-1".into(),
            source_name: "src.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/a.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        });
        container::write(
            &cuprum,
            &m,
            &[("gerbers/design-1/a.gbr".to_string(), b"G04 hi*".to_vec())],
        )
        .unwrap();

        let wd = root.join("wd");
        let marker = SessionMarker { source_path: cuprum.to_string_lossy().into(), pid: 1, opened_at: 7 };
        extract(&cuprum, &wd, &marker).unwrap();

        assert_eq!(read_manifest(&wd).unwrap(), m);
        assert_eq!(read_marker(&wd).unwrap(), marker);
        assert_eq!(
            std::fs::read(wd.join("gerbers/design-1/a.gbr")).unwrap(),
            b"G04 hi*"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_refuses_existing_dir() {
        let root = scratch("extract-exists");
        let cuprum = root.join("p.cu");
        container::write(&cuprum, &crate::manifest::Manifest::new("x"), &[]).unwrap();
        let wd = root.join("wd");
        std::fs::create_dir_all(&wd).unwrap();
        let marker = SessionMarker { source_path: cuprum.to_string_lossy().into(), pid: 1, opened_at: 0 };
        assert!(extract(&cuprum, &wd, &marker).is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
