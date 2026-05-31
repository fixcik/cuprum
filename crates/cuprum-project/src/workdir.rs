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
}
