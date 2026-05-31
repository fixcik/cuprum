//! Cuprum project model: the self-contained `.cuprum` ZIP container and the
//! SQLite recents catalog. Kept free of Tauri (and of the heavy core render
//! deps) so it builds and tests fast; the UI's Tauri layer is a thin proxy.

pub mod catalog;
pub mod container;
pub mod history;
pub mod import;
pub mod layer;
pub mod manifest;
pub mod panel;
pub mod workdir;

use std::path::{Path, PathBuf};

use anyhow::Result;

pub use catalog::RecentProject;
pub use history::{RestorePoint, RestorePointMeta};
pub use layer::LayerType;
pub use manifest::{GerberFile, Manifest, Stackup};
pub use panel::PanelDoc;
pub use workdir::{Orphan, SessionMarker};

/// Stable error token returned when a `.cuprum` file is missing on disk.
pub const PROJECT_NOT_FOUND: &str = "PROJECT_NOT_FOUND";

fn ensure_project_exists(container: &Path) -> Result<()> {
    if container.exists() {
        Ok(())
    } else {
        anyhow::bail!(PROJECT_NOT_FOUND)
    }
}

/// List recent projects from the catalog DB.
pub fn list_recent(db_path: &Path) -> Result<Vec<RecentProject>> {
    let conn = catalog::open(db_path)?;
    catalog::list(&conn)
}

/// Remove a project from the recents catalog (file untouched).
pub fn remove_recent(db_path: &Path, path: &str) -> Result<()> {
    let conn = catalog::open(db_path)?;
    catalog::remove(&conn, path)
}

/// Open an existing `.cuprum`: parse its manifest, migrate any legacy
/// `panel.json`, and record it as recently opened.
pub fn open_project(db_path: &Path, container: &Path, now: i64) -> Result<Manifest> {
    ensure_project_exists(container)?;
    let mut manifest = container::read_manifest(container).map_err(|e| {
        if !container.exists() {
            anyhow::anyhow!(PROJECT_NOT_FOUND)
        } else {
            e
        }
    })?;
    // Migration (schema v4): fold a legacy `panel.json` into the manifest, then
    // rewrite so the container is upgraded and the stray entry can be dropped.
    if manifest.panel.is_none() {
        if let Ok(Some(legacy)) = container::read_legacy_panel(container) {
            manifest.panel = Some(legacy);
            let _ = container::update_manifest(container, &manifest);
        }
    }
    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &container.to_string_lossy(), &manifest.name, now)?;
    Ok(manifest)
}

/// Disambiguate a basename against names already used in the same design:
/// "top.gbr" -> "top-2.gbr" -> "top-3.gbr" ...
fn unique_name(base: &str, used: &std::collections::HashSet<String>) -> String {
    if !used.contains(base) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem}-{n}{ext}");
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Pick the next free `design-N` id by scanning the working dir's `gerbers/`
/// folder. Filesystem-derived (not manifest-derived) so an undone-then-re-added
/// design — whose bytes are deliberately kept on disk — never reuses a live id.
fn next_design_id(workdir: &Path) -> String {
    let mut max = 0u32;
    if let Ok(rd) = std::fs::read_dir(workdir.join("gerbers")) {
        for ent in rd.flatten() {
            if !ent.path().is_dir() {
                continue;
            }
            let name = ent.file_name();
            let name = name.to_string_lossy();
            if let Some(n) = name.strip_prefix("design-").and_then(|s| s.parse::<u32>().ok()) {
                max = max.max(n);
            }
        }
    }
    format!("design-{}", max + 1)
}

/// Add one source ZIP as a new Design directly inside an open project's working
/// dir: copy each gerber to `gerbers/<new-id>/<name>` (deduping basenames),
/// classify it by filename, and return the [`manifest::Design`] for the caller to
/// merge into the manifest. Does NOT touch the manifest or the `.cuprum` — the UI
/// merges the returned design and persists through the normal autosave path.
pub fn add_design_to_workdir(workdir: &Path, zip_path: &Path) -> Result<manifest::Design> {
    let imported = import::read_zip_gerbers(zip_path)?;
    let id = next_design_id(workdir);
    let design_dir = workdir.join("gerbers").join(&id);
    std::fs::create_dir_all(&design_dir)?;

    let mut gerbers = Vec::new();
    let mut used = std::collections::HashSet::new();
    for (base, bytes) in &imported.gerbers {
        let name = unique_name(base, &used);
        used.insert(name.clone());
        std::fs::write(design_dir.join(&name), bytes)?;
        let rel = format!("gerbers/{id}/{name}");
        gerbers.push(manifest::GerberFile {
            path: rel,
            layer_type: layer::classify(&name),
        });
    }
    Ok(manifest::Design {
        id,
        source_name: imported.source_name,
        gerbers,
    })
}

/// Build container entries (gerbers) + manifest designs from a set of imported
/// ZIPs. Each gerber is classified by its file name (see [`layer::classify`]).
/// Shared by create_project and import_zips.
fn build_entries(
    imports: &[import::ImportedZip],
) -> (Vec<manifest::Design>, Vec<(String, Vec<u8>)>) {
    let mut manifest_designs = Vec::new();
    let mut entries = Vec::new();

    for (idx, imp) in imports.iter().enumerate() {
        let id = format!("design-{}", idx + 1);
        let mut gerbers = Vec::new();
        let mut used = std::collections::HashSet::new();
        for (base, bytes) in &imp.gerbers {
            let name = unique_name(base, &used);
            used.insert(name.clone());
            let rel = format!("gerbers/{id}/{name}");
            entries.push((rel.clone(), bytes.clone()));
            gerbers.push(manifest::GerberFile {
                path: rel,
                layer_type: layer::classify(&name),
            });
        }
        manifest_designs.push(manifest::Design {
            id,
            source_name: imp.source_name.clone(),
            gerbers,
        });
    }
    (manifest_designs, entries)
}

/// Create a new project: import one or more source ZIPs into a `.cuprum`
/// container at `save_path`, and record it in the catalog.
pub fn create_project(
    db_path: &Path,
    save_path: &Path,
    name: &str,
    zip_paths: &[PathBuf],
    now: i64,
) -> Result<Manifest> {
    let imports: Vec<import::ImportedZip> = zip_paths
        .iter()
        .map(|p| import::read_zip_gerbers(p))
        .collect::<Result<_>>()?;

    let (manifest_designs, entries) = build_entries(&imports);
    let mut manifest = Manifest::new(name);
    manifest.designs = manifest_designs;

    container::write(save_path, &manifest, &entries)?;

    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &save_path.to_string_lossy(), name, now)?;
    Ok(manifest)
}

/// Import additional ZIPs into an existing container, rewriting it. Returns the
/// updated manifest. Also bumps `last_opened_at` in the recents catalog.
pub fn import_zips(
    db_path: &Path,
    container: &Path,
    zip_paths: &[PathBuf],
    now: i64,
) -> Result<Manifest> {
    ensure_project_exists(container)?;
    let existing = container::read_manifest(container).map_err(|e| {
        if !container.exists() {
            anyhow::anyhow!(PROJECT_NOT_FOUND)
        } else {
            e
        }
    })?;

    // Re-read existing gerbers so the rewritten container keeps them.
    let mut imports: Vec<import::ImportedZip> = Vec::new();
    for design in &existing.designs {
        let mut gerbers = Vec::new();
        for g in &design.gerbers {
            let base = g.path.rsplit('/').next().unwrap_or(&g.path).to_string();
            let bytes = container::read_entry(container, &g.path)?;
            gerbers.push((base, bytes));
        }
        imports.push(import::ImportedZip {
            source_name: design.source_name.clone(),
            gerbers,
        });
    }
    for p in zip_paths {
        imports.push(import::read_zip_gerbers(p)?);
    }

    let (manifest_designs, entries) = build_entries(&imports);
    let mut manifest = Manifest::new(&existing.name);
    manifest.description = existing.description;
    manifest.layer_colors = existing.layer_colors;
    manifest.designs = manifest_designs;
    manifest.exposure = existing.exposure;
    manifest.placements = existing.placements;
    manifest.stackup = existing.stackup.clone();
    manifest.panel = existing.panel.clone();

    // Preserve layer types the user assigned to already-imported files; the
    // rebuild above re-classified them by filename, which would wipe overrides.
    for (i, old) in existing.designs.iter().enumerate() {
        if let Some(new_design) = manifest.designs.get_mut(i) {
            for (g, old_g) in new_design.gerbers.iter_mut().zip(old.gerbers.iter()) {
                g.layer_type = old_g.layer_type;
            }
        }
    }

    container::write(container, &manifest, &entries)?;
    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &container.to_string_lossy(), &manifest.name, now)?;
    Ok(manifest)
}

/// Import ZIPs into an existing container, then set the layer type of each
/// newly-added gerber from `layer_types`, applied POSITIONALLY in staging order
/// (the i-th value targets the i-th gerber across the imports just added). This
/// is dedup-stable: the wizard's `stage_import` emits files in the same flat
/// order `build_entries` walks, and dedup never drops or reorders files.
/// Already-existing designs keep their layer types (see `import_zips`).
pub fn commit_import(
    db_path: &Path,
    container: &Path,
    zip_paths: &[PathBuf],
    layer_types: &[LayerType],
    now: i64,
) -> Result<Manifest> {
    // Number of designs already present, so we only re-type the newly added ones.
    let existing_count = container::read_manifest(container)
        .map(|m| m.designs.len())
        .unwrap_or(0);

    let mut manifest = import_zips(db_path, container, zip_paths, now)?;

    let new_gerbers = manifest
        .designs
        .iter_mut()
        .skip(existing_count)
        .flat_map(|design| design.gerbers.iter_mut());
    for (g, lt) in new_gerbers.zip(layer_types.iter()) {
        g.layer_type = *lt;
    }

    // import_zips already rewrote the container; rewrite the manifest once more
    // so the wizard's layer types land on disk.
    container::update_manifest(container, &manifest)?;
    Ok(manifest)
}

/// Update project display name and description in the container manifest.
pub fn update_project_metadata(
    db_path: &Path,
    container: &Path,
    name: &str,
    description: &str,
    now: i64,
) -> Result<Manifest> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("project name cannot be empty");
    }

    ensure_project_exists(container)?;

    let mut manifest = container::read_manifest(container).map_err(|e| {
        if !container.exists() {
            anyhow::anyhow!(PROJECT_NOT_FOUND)
        } else {
            e
        }
    })?;
    manifest.name = name.to_string();
    manifest.description = description.trim().to_string();
    container::update_manifest(container, &manifest)?;

    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &container.to_string_lossy(), &manifest.name, now)?;
    Ok(manifest)
}

/// Read the panel blank from the manifest, or `None` if not yet configured.
pub fn read_panel(container: &Path) -> Result<Option<PanelDoc>> {
    ensure_project_exists(container)?;
    Ok(container::read_manifest(container)?.panel)
}

/// Configure the panel blank: store the `Stackup` and `PanelDoc` on the
/// manifest. Bumps `last_opened_at`.
pub fn configure_panel(
    db_path: &Path,
    container: &Path,
    panel: &PanelDoc,
    stackup: Stackup,
    now: i64,
) -> Result<Manifest> {
    ensure_project_exists(container)?;
    if !panel.width_mm.is_finite()
        || !panel.height_mm.is_finite()
        || panel.width_mm <= 0.0
        || panel.height_mm <= 0.0
    {
        anyhow::bail!("panel dimensions must be finite and > 0");
    }
    if !stackup.copper_weight_oz.is_finite()
        || !stackup.substrate_thickness_mm.is_finite()
        || stackup.copper_weight_oz <= 0.0
        || stackup.substrate_thickness_mm <= 0.0
    {
        anyhow::bail!("stackup values must be finite and > 0");
    }
    let mut manifest = container::read_manifest(container)?;
    manifest.stackup = Some(stackup);
    manifest.panel = Some(panel.clone());
    container::update_manifest(container, &manifest)?;

    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &container.to_string_lossy(), &manifest.name, now)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn make_source_zip(dir: &Path, file_name: &str) -> PathBuf {
        let path = dir.join(file_name);
        let f = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        zip.start_file("board.gbr", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"G04 board*").unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn add_design_to_workdir_copies_and_classifies() {
        use crate::layer::LayerType;
        let dir = std::env::temp_dir().join(format!("cuprum-add-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        // A source ZIP with a top-copper and an edge layer.
        let zip = dir.join("board.zip");
        {
            use std::io::Write;
            use zip::write::SimpleFileOptions;
            let f = std::fs::File::create(&zip).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o = SimpleFileOptions::default();
            z.start_file("board-F_Cu.gbr", o).unwrap();
            z.write_all(b"G04 cu*").unwrap();
            z.start_file("board-Edge_Cuts.gbr", o).unwrap();
            z.write_all(b"G04 edge*").unwrap();
            z.finish().unwrap();
        }

        // An empty working dir with a manifest (as `extract` would leave it).
        let wd = dir.join("wd");
        std::fs::create_dir_all(&wd).unwrap();
        crate::workdir::write_manifest(&wd, &Manifest::new("demo")).unwrap();

        let design = add_design_to_workdir(&wd, &zip).unwrap();

        assert_eq!(design.id, "design-1");
        assert_eq!(design.source_name, "board.zip");
        assert_eq!(design.gerbers.len(), 2);
        // Files landed under gerbers/design-1/ on disk.
        assert_eq!(
            std::fs::read(wd.join("gerbers/design-1/board-F_Cu.gbr")).unwrap(),
            b"G04 cu*"
        );
        // Paths are container-relative with forward slashes.
        assert!(design
            .gerbers
            .iter()
            .any(|g| g.path == "gerbers/design-1/board-F_Cu.gbr"
                && g.layer_type == LayerType::TopCopper));
        assert!(design
            .gerbers
            .iter()
            .any(|g| g.layer_type == LayerType::EdgeCuts));

        // A SECOND add gets the next id from the filesystem, even though the manifest
        // wasn't updated between calls (mirrors the multi-zip loop in the store).
        let d2 = add_design_to_workdir(&wd, &zip).unwrap();
        assert_eq!(d2.id, "design-2");
        assert!(wd.join("gerbers/design-2/board-F_Cu.gbr").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_open_import_flow() {
        let dir = std::env::temp_dir().join(format!("cuprum-lib-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let zip1 = make_source_zip(&dir, "one.zip");
        let save = dir.join("proj.cuprum");

        let m = create_project(&db, &save, "proj", &[zip1], 1000).unwrap();
        assert_eq!(m.name, "proj");
        assert_eq!(m.designs.len(), 1);
        assert_eq!(m.designs[0].gerbers[0].path, "gerbers/design-1/board.gbr");

        // recents has it.
        let recents = list_recent(&db).unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].name, "proj");
        assert!(recents[0].exists);

        // open returns the same manifest.
        let opened = open_project(&db, &save, 2000).unwrap();
        assert_eq!(opened.designs.len(), 1);

        // import a second ZIP -> two imports, originals preserved.
        let zip2 = make_source_zip(&dir, "two.zip");
        let m2 = import_zips(&db, &save, &[zip2], 3000).unwrap();
        assert_eq!(m2.designs.len(), 2);
        assert_eq!(m2.designs[1].id, "design-2");
        assert_eq!(
            container::read_entry(&save, "gerbers/design-1/board.gbr").unwrap(),
            b"G04 board*"
        );

        // recents entry's last_opened_at is updated to 3000 after import.
        let recents = list_recent(&db).unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].last_opened_at, 3000);

        std::fs::remove_dir_all(&dir).ok();
    }

    fn make_dup_source_zip(dir: &Path, file_name: &str) -> PathBuf {
        // Contains two files with the same basename under different directories.
        let path = dir.join(file_name);
        let f = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zip.start_file("a/top.gbr", opts).unwrap();
        zip.write_all(b"AAA").unwrap();
        zip.start_file("b/top.gbr", opts).unwrap();
        zip.write_all(b"BBB").unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn dedup_duplicate_basenames() {
        let dir = std::env::temp_dir().join(format!("cuprum-dedup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let zip1 = make_dup_source_zip(&dir, "dup.zip");
        let save = dir.join("dup.cuprum");

        let m = create_project(&db, &save, "dup-test", &[zip1], 1000).unwrap();
        assert_eq!(m.designs.len(), 1);

        let gerbers = &m.designs[0].gerbers;
        assert_eq!(gerbers.len(), 2, "both gerbers must be present");
        assert_ne!(
            gerbers[0].path, gerbers[1].path,
            "rel paths must be distinct after dedup"
        );
        let bytes0 = container::read_entry(&save, &gerbers[0].path).unwrap();
        let bytes1 = container::read_entry(&save, &gerbers[1].path).unwrap();
        let both: std::collections::HashSet<Vec<u8>> = [bytes0, bytes1].into_iter().collect();
        assert!(both.contains(b"AAA" as &[u8]), "AAA payload must be stored");
        assert!(both.contains(b"BBB" as &[u8]), "BBB payload must be stored");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_import_applies_layer_types_positionally() {
        let dir = std::env::temp_dir().join(format!("cuprum-commit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        // board.gbr auto-classifies to Other; the wizard overrides it to TopCopper.
        let zip = make_source_zip(&dir, "pkg.zip"); // contains board.gbr
        let m = commit_import(&db, &save, &[zip], &[LayerType::TopCopper], 2000).unwrap();
        assert_eq!(m.designs.len(), 1);
        assert_eq!(m.designs[0].gerbers[0].path, "gerbers/design-1/board.gbr");
        assert_eq!(m.designs[0].gerbers[0].layer_type, LayerType::TopCopper);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_import_positional_survives_dedup() {
        let dir = std::env::temp_dir().join(format!("cuprum-commit-dup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        let zip = make_dup_source_zip(&dir, "dup.zip"); // two "top.gbr" (a/, b/)
        let m = commit_import(
            &db,
            &save,
            &[zip],
            &[LayerType::TopCopper, LayerType::BottomCopper],
            2000,
        )
        .unwrap();

        let gerbers = &m.designs[0].gerbers;
        assert_eq!(gerbers.len(), 2);
        assert_eq!(gerbers[0].layer_type, LayerType::TopCopper);
        assert_eq!(
            gerbers[1].layer_type,
            LayerType::BottomCopper,
            "2nd choice must land on the deduped file"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reimport_preserves_existing_layer_types() {
        let dir = std::env::temp_dir().join(format!("cuprum-reimport-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        let zip1 = make_source_zip(&dir, "one.zip");
        commit_import(&db, &save, &[zip1], &[LayerType::TopCopper], 2000).unwrap();

        let zip2 = make_source_zip(&dir, "two.zip");
        let m = import_zips(&db, &save, &[zip2], 3000).unwrap();
        assert_eq!(m.designs.len(), 2);
        assert_eq!(
            m.designs[0].gerbers[0].layer_type,
            LayerType::TopCopper,
            "existing import's layer type must survive a later import_zips"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_missing_project_returns_not_found() {
        let dir = std::env::temp_dir().join(format!("cuprum-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let missing = dir.join("gone.cuprum");

        let err = open_project(&db, &missing, 1000).unwrap_err();
        assert_eq!(err.to_string(), PROJECT_NOT_FOUND);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn configure_panel_sets_stackup_and_panel() {
        use crate::manifest::Stackup;
        use crate::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-cfgpanel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        // Not configured initially.
        assert!(open_project(&db, &save, 1500).unwrap().panel.is_none());
        assert!(open_project(&db, &save, 1500).unwrap().stackup.is_none());

        let m = configure_panel(
            &db,
            &save,
            &PanelDoc::new(150.0, 100.0),
            Stackup {
                copper_weight_oz: 1.0,
                substrate_thickness_mm: 1.6,
                double_sided: false,
            },
            2000,
        )
        .unwrap();
        assert_eq!(m.stackup.as_ref().unwrap().copper_weight_oz, 1.0);
        assert_eq!(m.panel.as_ref().unwrap().width_mm, 150.0);

        // Persisted: reopening sees both.
        let re = open_project(&db, &save, 2500).unwrap();
        assert!(re.stackup.is_some());
        assert_eq!(re.panel.unwrap().width_mm, 150.0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn configure_panel_rejects_bad_dimensions() {
        use crate::manifest::Stackup;
        use crate::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-badpanel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        let ok = Stackup {
            copper_weight_oz: 1.0,
            substrate_thickness_mm: 1.6,
            double_sided: false,
        };
        // Non-positive dimension is rejected, and nothing is written.
        assert!(configure_panel(&db, &save, &PanelDoc::new(0.0, 100.0), ok.clone(), 2000).is_err());
        assert!(open_project(&db, &save, 1500).unwrap().panel.is_none());
        // Non-positive stackup value is rejected too.
        let bad = Stackup {
            copper_weight_oz: 0.0,
            substrate_thickness_mm: 1.6,
            double_sided: false,
        };
        assert!(configure_panel(&db, &save, &PanelDoc::new(150.0, 100.0), bad, 2000).is_err());
        assert!(open_project(&db, &save, 1600).unwrap().panel.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reimport_preserves_stackup() {
        use crate::manifest::Stackup;
        use crate::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-reimp-stk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();
        configure_panel(
            &db,
            &save,
            &PanelDoc::new(150.0, 100.0),
            Stackup {
                copper_weight_oz: 1.0,
                substrate_thickness_mm: 1.6,
                double_sided: true,
            },
            2000,
        )
        .unwrap();

        // A reimport (here: zero new zips) must not wipe the stackup.
        let m = import_zips(&db, &save, &[], 3000).unwrap();
        assert!(m.stackup.as_ref().unwrap().double_sided);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_migrates_legacy_panel_json() {
        use crate::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("legacy.cuprum");

        // Hand-build a v3-style container: manifest without `panel`, plus a
        // separate panel.json entry.
        let m = Manifest::new("legacy");
        let p = PanelDoc::new(99.0, 55.0);
        let entries = vec![(
            container::PANEL_NAME.to_string(),
            serde_json::to_vec_pretty(&p).unwrap(),
        )];
        container::write(&save, &m, &entries).unwrap();

        // Opening folds the legacy panel into the manifest.
        let opened = open_project(&db, &save, 1000).unwrap();
        assert_eq!(opened.panel.unwrap().width_mm, 99.0);

        std::fs::remove_dir_all(&dir).ok();
    }
}
