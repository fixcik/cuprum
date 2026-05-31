//! Read/write the `.cuprum` container — a ZIP archive holding `manifest.json`
//! and raw Gerber files under `gerbers/<import-id>/`.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use anyhow::{anyhow, Result};
use zip::write::SimpleFileOptions;

use crate::manifest::Manifest;
use crate::panel::PanelDoc;

pub const MANIFEST_NAME: &str = "manifest.json";

/// Panel settings live in their own container entry (written/read when the
/// exposure editor is wired in), not embedded in the manifest.
pub const PANEL_NAME: &str = "panel.json";

/// Write a complete container: the manifest plus every entry in `entries`
/// (archive-relative path -> bytes). Gerbers are passed as entries by the caller.
pub fn write(path: &Path, manifest: &Manifest, entries: &[(String, Vec<u8>)]) -> Result<()> {
    // Write to a sibling temp file, then atomically rename into place, so a
    // failed/partial write never corrupts an existing project file.
    let mut tmp_os = path.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp_os);

    let build = (|| -> Result<()> {
        let file = File::create(&tmp)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(MANIFEST_NAME, opts)?;
        zip.write_all(serde_json::to_string_pretty(manifest)?.as_bytes())?;
        for (name, bytes) in entries {
            zip.start_file(name.as_str(), opts)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
        Ok(())
    })();

    match build {
        Ok(()) => {
            std::fs::rename(&tmp, path)?;
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Read and parse `manifest.json`.
pub fn read_manifest(path: &Path) -> Result<Manifest> {
    let bytes = read_entry(path, MANIFEST_NAME)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Read a single entry by its archive-relative name.
pub fn read_entry(path: &Path, name: &str) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entry = archive
        .by_name(name)
        .map_err(|_| anyhow!("entry '{name}' not found in {}", path.display()))?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Replace `manifest.json` while preserving every other ZIP entry.
pub fn update_manifest(path: &Path, manifest: &Manifest) -> Result<()> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        entries.push((name, buf));
    }
    write(path, manifest, &entries)
}

/// Read and parse `panel.json`. Returns `None` if the blank isn't configured
/// yet (entry absent); a present-but-corrupt entry is an error.
pub fn read_panel(path: &Path) -> Result<Option<PanelDoc>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let buf = match archive.by_name(PANEL_NAME) {
        Ok(mut entry) => {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            buf
        }
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok(Some(serde_json::from_slice(&buf)?))
}

/// Write/replace `panel.json` while preserving the manifest and every other
/// ZIP entry.
pub fn update_panel(path: &Path, panel: &PanelDoc) -> Result<()> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut manifest_bytes: Option<Vec<u8>> = None;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        if name == MANIFEST_NAME {
            manifest_bytes = Some(buf);
        } else if name == PANEL_NAME {
            // drop the old panel.json; we re-add the new one below
        } else {
            entries.push((name, buf));
        }
    }
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes.ok_or_else(|| anyhow!("manifest.json missing"))?)?;
    entries.push((PANEL_NAME.to_string(), serde_json::to_vec_pretty(panel)?));
    write(path, &manifest, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layer::LayerType;
    use crate::manifest::{Design, GerberFile, Manifest};

    #[test]
    fn write_then_read_round_trip() {
        let dir = std::env::temp_dir().join(format!("cuprum-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.cuprum");

        let mut m = Manifest::new("demo");
        m.designs.push(Design {
            id: "design-1".into(),
            source_name: "demo.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/a.gbr".into(),
                layer_type: LayerType::Other,
            }],
        });
        let entries = vec![("gerbers/design-1/a.gbr".to_string(), b"G04 hi*".to_vec())];
        write(&path, &m, &entries).unwrap();

        assert_eq!(read_manifest(&path).unwrap(), m);
        assert_eq!(
            read_entry(&path, "gerbers/design-1/a.gbr").unwrap(),
            b"G04 hi*"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_missing_entry_is_err() {
        let dir = std::env::temp_dir().join(format!("cuprum-test-me-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("me.cuprum");
        write(&path, &Manifest::new("x"), &[]).unwrap();
        assert!(read_entry(&path, "nope.gbr").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("cuprum-test-tmp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("atomic.cuprum");

        let mut m = Manifest::new("atomic-test");
        m.designs.push(Design {
            id: "design-1".into(),
            source_name: "src.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/a.gbr".into(),
                layer_type: LayerType::Other,
            }],
        });
        let entries = vec![(
            "gerbers/design-1/a.gbr".to_string(),
            b"G04 atomic*".to_vec(),
        )];
        write(&path, &m, &entries).unwrap();

        // The .tmp sibling must not exist after a successful write.
        let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
        assert!(
            !tmp.exists(),
            ".tmp file should not exist after successful write"
        );

        // Content round-trips correctly.
        assert_eq!(read_manifest(&path).unwrap(), m);
        assert_eq!(
            read_entry(&path, "gerbers/design-1/a.gbr").unwrap(),
            b"G04 atomic*"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn panel_missing_then_written() {
        use crate::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-panel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.cuprum");
        write(&path, &Manifest::new("demo"), &[]).unwrap();

        // No panel.json yet -> None.
        assert!(read_panel(&path).unwrap().is_none());

        // Writing one is readable, and the manifest survives.
        let p = PanelDoc::new(120.0, 80.0);
        update_panel(&path, &p).unwrap();
        assert_eq!(read_panel(&path).unwrap(), Some(p));
        assert_eq!(read_manifest(&path).unwrap().name, "demo");

        std::fs::remove_dir_all(&dir).ok();
    }
}
