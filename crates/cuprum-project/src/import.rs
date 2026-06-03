//! Unpack a source ZIP (a Gerber fab package) and collect its Gerber/drill files
//! into memory. Layer classification (F_Cu / drill / Edge_Cuts ...) is a later
//! spec — here we just keep files whose extension looks like Gerber or Excellon.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::Result;

/// Extensions we treat as Gerber/drill artwork. Deliberately strict — only real
/// Gerber and Excellon-drill extensions, so package extras (README.txt, BOM.csv,
/// .gbrjob, fab notes) are dropped rather than imported as bogus "layers".
/// `nc`/`xln` are kept as common Excellon drill extensions; `txt` is NOT, since
/// it overwhelmingly means a readme, not a drill file.
const GERBER_EXTS: &[&str] = &[
    "gbr", "grb", "ger", "gtl", "gbl", "gto", "gbo", "gts", "gbs", "gko", "gm1", "gpb", "gpt",
    "drl", "xln", "nc",
];

fn is_gerber_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit('.').next() {
        Some(ext) => GERBER_EXTS.contains(&ext),
        None => false,
    }
}

/// One imported package: the source ZIP name and its Gerber files (basename ->
/// bytes). Directory paths inside the ZIP are flattened to base file names.
pub struct ImportedZip {
    pub source_name: String,
    pub gerbers: Vec<(String, Vec<u8>)>,
}

/// Read a source ZIP and return its Gerber/drill files.
pub fn read_zip_gerbers(zip_path: &Path) -> Result<ImportedZip> {
    let span = tracing::info_span!("read_zip", files = tracing::field::Empty);
    let _e = span.enter();

    let source_name = zip_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "package.zip".into());

    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut gerbers = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if !entry.is_file() {
            continue;
        }
        let full = entry.name().to_string();
        // Skip macOS archive cruft: the `__MACOSX/` shadow tree and `._<name>`
        // AppleDouble metadata files that otherwise mirror (double) every layer.
        if full.contains("__MACOSX/") {
            continue;
        }
        let base = full.rsplit('/').next().unwrap_or(&full).to_string();
        if base.starts_with("._") {
            continue;
        }
        if !is_gerber_name(&base) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        gerbers.push((base, buf));
    }
    span.record("files", gerbers.len());
    Ok(ImportedZip {
        source_name,
        gerbers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    use crate::test_trace::collect_span_names;

    fn make_zip(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("src.zip");
        let f = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zip.start_file("gerbers/top.gbr", opts).unwrap();
        zip.write_all(b"G04 top*").unwrap();
        zip.start_file("gerbers/bottom.gbl", opts).unwrap();
        zip.write_all(b"G04 bottom*").unwrap();
        zip.start_file("readme.md", opts).unwrap(); // not a gerber ext
        zip.write_all(b"hello").unwrap();
        zip.start_file("notes.txt", opts).unwrap(); // readme-style text, NOT a drill
        zip.write_all(b"hello").unwrap();
        zip.start_file("project.gbrjob", opts).unwrap(); // job file, not a layer
        zip.write_all(b"{}").unwrap();
        // macOS archive cruft that would otherwise double every layer.
        zip.start_file("__MACOSX/gerbers/._top.gbr", opts).unwrap();
        zip.write_all(b"junk").unwrap();
        zip.start_file("._bottom.gbl", opts).unwrap();
        zip.write_all(b"junk").unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn read_zip_emits_read_zip_span() {
        let dir = std::env::temp_dir().join(format!("cuprum-imp-span-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip = make_zip(&dir);

        let (result, names) = collect_span_names(|| read_zip_gerbers(&zip));
        result.unwrap();
        assert!(
            names.contains(&"read_zip".to_string()),
            "expected read_zip span, got: {names:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collects_only_gerber_files_flattened() {
        let dir = std::env::temp_dir().join(format!("cuprum-imp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip = make_zip(&dir);

        let imported = read_zip_gerbers(&zip).unwrap();
        assert_eq!(imported.source_name, "src.zip");
        let names: Vec<_> = imported.gerbers.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"top.gbr"));
        assert!(names.contains(&"bottom.gbl"));
        // Only the two real layers: .txt/.gbrjob/.md and AppleDouble cruft excluded.
        assert_eq!(imported.gerbers.len(), 2, "got {names:?}");
        assert!(
            !names.iter().any(|n| n.starts_with("._")),
            "AppleDouble leaked: {names:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
