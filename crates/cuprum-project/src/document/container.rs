//! Read/write the `.cuprum` container — a ZIP archive holding `manifest.json`
//! and raw Gerber files under `gerbers/<import-id>/`.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use anyhow::{anyhow, Result};
use zip::write::SimpleFileOptions;

use crate::document::manifest::Manifest;
use crate::document::panel::PanelDoc;

pub const MANIFEST_NAME: &str = "manifest.json";

/// Archive entry name for the legacy panel file (schema ≤ v3).
/// No longer written; used only for migration reads on open and for
/// exclusion when packing the working directory.
pub const PANEL_NAME: &str = "panel.json";

/// Choose ZIP compression options based on the entry name.
///
/// PNG previews are already compressed — storing them avoids wasted deflate
/// work and reduces flush latency. Everything else (manifest, gerbers, SVG,
/// metrics) compresses reasonably well; level 1 favours speed over ratio.
fn entry_options(name: &str) -> SimpleFileOptions {
    if name.starts_with("artifacts/preview/") {
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
    } else {
        SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(1))
    }
}

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
        // Span wraps only the compression writes (start_file/write_all/finish).
        let _s = tracing::info_span!("zip_write", entries = entries.len()).entered();
        zip.start_file(MANIFEST_NAME, entry_options(MANIFEST_NAME))?;
        zip.write_all(serde_json::to_string_pretty(manifest)?.as_bytes())?;
        for (name, bytes) in entries {
            zip.start_file(name.as_str(), entry_options(name))?;
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

/// Read and migrate `manifest.json`.
pub fn read_manifest(path: &Path) -> Result<Manifest> {
    let bytes = read_entry(path, MANIFEST_NAME)?;
    crate::document::migrate::manifest_from_slice(&bytes)
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

/// Read a legacy `panel.json` entry (schema ≤ v3). Returns None when absent.
/// Used only to migrate the blank into the manifest on open.
pub fn read_legacy_panel(path: &Path) -> Result<Option<PanelDoc>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::manifest::{Design, GerberFile, Manifest};
    use crate::layer::LayerType;

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
    fn preview_stored_text_deflated() {
        let dir = std::env::temp_dir().join(format!("cuprum-test-compress-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("compress.cuprum");

        let preview_bytes: Vec<u8> =
            b"\x89PNG\r\n\x1a\nsome binary preview data that looks like PNG".to_vec();
        let gerber_bytes: Vec<u8> = b"G04 hello world hello world*".to_vec();

        let entries = vec![
            ("artifacts/preview/x.bin".to_string(), preview_bytes.clone()),
            ("gerbers/a.gbr".to_string(), gerber_bytes.clone()),
        ];
        write(&path, &Manifest::new("t"), &entries).unwrap();

        // Round-trip: content must be identical to what was written.
        assert_eq!(
            read_entry(&path, "artifacts/preview/x.bin").unwrap(),
            preview_bytes
        );
        assert_eq!(read_entry(&path, "gerbers/a.gbr").unwrap(), gerber_bytes);

        // Compression method must match the per-entry policy.
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();

        let preview_method = archive
            .by_name("artifacts/preview/x.bin")
            .unwrap()
            .compression();
        assert_eq!(
            preview_method,
            zip::CompressionMethod::Stored,
            "preview entry should be Stored"
        );

        let gerber_method = archive.by_name("gerbers/a.gbr").unwrap().compression();
        assert_eq!(
            gerber_method,
            zip::CompressionMethod::Deflated,
            "gerber entry should be Deflated"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_panel_read() {
        use crate::document::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-legacy-panel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.cuprum");

        // Container with no panel.json -> None.
        write(&path, &Manifest::new("demo"), &[]).unwrap();
        assert!(read_legacy_panel(&path).unwrap().is_none());

        // Container carrying a legacy panel.json entry -> Some.
        let p = PanelDoc::new(120.0, 80.0);
        let entries = vec![(
            PANEL_NAME.to_string(),
            serde_json::to_vec_pretty(&p).unwrap(),
        )];
        write(&path, &Manifest::new("demo"), &entries).unwrap();
        assert_eq!(read_legacy_panel(&path).unwrap(), Some(p));

        std::fs::remove_dir_all(&dir).ok();
    }
}
