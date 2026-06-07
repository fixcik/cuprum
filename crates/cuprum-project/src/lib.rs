//! Cuprum project model: the self-contained `.cuprum` ZIP container and the
//! SQLite recents catalog. Kept free of Tauri (and of the heavy core render
//! deps) so it builds and tests fast; the UI's Tauri layer is a thin proxy.

pub mod catalog;
pub mod document;
pub mod import;
pub mod layer;
pub mod resolve;

/// Test-only tracing support shared across this crate's test modules.
#[cfg(test)]
pub(crate) mod test_trace {
    // A minimal Subscriber that records entered span names into a shared Vec.
    //
    // Tracing caches callsite interest globally. A callsite first visited with
    // no subscriber gets cached as NEVER and is skipped even when a thread-local
    // subscriber is later active. Fix: install a global "sometimes-interested"
    // stub once per process so callsites are cached as SOMETIMES, which makes
    // them re-check the thread-local dispatcher on every invocation. This crate's
    // test binary has no competing global subscriber, so the stub is harmless.
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};

    /// Hand out a fresh, non-zero span id (tracing requires a unique id per live
    /// span). Shared by both stub subscribers below.
    fn next_id(counter: &AtomicU64) -> tracing::span::Id {
        tracing::span::Id::from_u64(counter.fetch_add(1, Ordering::Relaxed))
    }

    /// Noop global subscriber that marks every callsite as SOMETIMES interested,
    /// keeping the per-call dispatcher check active for thread-local overrides.
    struct SometimesSubscriber(AtomicU64);
    impl tracing::Subscriber for SometimesSubscriber {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            false // we don't actually handle events; just keep interest alive
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            next_id(&self.0)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, _: &tracing::Event<'_>) {}
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
        fn register_callsite(
            &self,
            _: &'static tracing::Metadata<'static>,
        ) -> tracing::subscriber::Interest {
            tracing::subscriber::Interest::sometimes()
        }
    }

    fn ensure_global_subscriber() {
        static INIT: OnceLock<()> = OnceLock::new();
        INIT.get_or_init(|| {
            let _ = tracing::subscriber::set_global_default(SometimesSubscriber(AtomicU64::new(1)));
        });
    }

    struct NameCollector {
        names: Arc<Mutex<Vec<String>>>,
        /// Span id -> name, populated on creation so `enter` can record the name.
        ids: Mutex<HashMap<u64, &'static str>>,
        next: AtomicU64,
    }
    impl tracing::Subscriber for NameCollector {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, attrs: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            let id = next_id(&self.next);
            self.ids
                .lock()
                .unwrap()
                .insert(id.into_u64(), attrs.metadata().name());
            id
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, _: &tracing::Event<'_>) {}
        // Record on enter (not new_span), mirroring production routing, which emits
        // events on span enter/exit rather than on creation.
        fn enter(&self, id: &tracing::span::Id) {
            if let Some(name) = self.ids.lock().unwrap().get(&id.into_u64()) {
                self.names.lock().unwrap().push((*name).to_string());
            }
        }
        fn exit(&self, _: &tracing::span::Id) {}
    }

    /// Run `f` capturing the names of every span entered during it.
    pub(crate) fn collect_span_names<R>(f: impl FnOnce() -> R) -> (R, Vec<String>) {
        ensure_global_subscriber();
        let names = Arc::new(Mutex::new(Vec::new()));
        let sub = NameCollector {
            names: names.clone(),
            ids: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        };
        let r = tracing::subscriber::with_default(sub, f);
        let v = names.lock().unwrap().clone();
        (r, v)
    }
}

use std::path::{Path, PathBuf};

use anyhow::Result;

pub use catalog::{OperationRun, RecentProject};
pub use document::history::{RestorePoint, RestorePointMeta};
pub use document::manifest::{GerberFile, Manifest, Stackup};
pub use document::panel::PanelDoc;
pub use document::workdir::{Orphan, SessionMarker};
pub use document::{container, history, manifest, panel, workdir};
pub use layer::LayerType;
pub use resolve::{resolve_design, DesignSource, ResolveOpts, ResolvedDesign, ResolvedLayer};

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

// ---- Operation-run journal (path-taking wrappers over `catalog`) ----

/// Record a just-launched operation run.
pub fn operation_run_start(
    db_path: &Path,
    run_uid: &str,
    project_path: &str,
    op_type: &str,
    started_at: i64,
    progress_total: Option<i64>,
    params_json: &str,
) -> Result<()> {
    let conn = catalog::open(db_path)?;
    catalog::operation_run_start(
        &conn,
        run_uid,
        project_path,
        op_type,
        started_at,
        progress_total,
        params_json,
    )
}

/// Finalize an operation run (outcome + completed count + optional summary).
pub fn operation_run_finish(
    db_path: &Path,
    run_uid: &str,
    ended_at: i64,
    outcome: &str,
    progress_done: i64,
    summary_json: Option<&str>,
) -> Result<()> {
    let conn = catalog::open(db_path)?;
    catalog::operation_run_finish(
        &conn,
        run_uid,
        ended_at,
        outcome,
        progress_done,
        summary_json,
    )
}

/// List operation runs for a project (newest first), optionally filtered by type.
pub fn operation_runs_list(
    db_path: &Path,
    project_path: &str,
    op_type: Option<&str>,
) -> Result<Vec<OperationRun>> {
    let conn = catalog::open(db_path)?;
    catalog::operation_runs_list(&conn, project_path, op_type)
}

/// The most recent run's `params_json` for a project + op type (prefill default).
pub fn operation_run_last_params(
    db_path: &Path,
    project_path: &str,
    op_type: &str,
) -> Result<Option<String>> {
    let conn = catalog::open(db_path)?;
    catalog::operation_run_last_params(&conn, project_path, op_type)
}

/// Store the panel verdict and the capability-profile hash it was computed
/// against, WITHOUT bumping `last_opened_at` or touching stat columns.
/// No-op if the path isn't in the catalog yet.
pub fn set_recent_verdict(
    db_path: &Path,
    path: &str,
    verdict: &str,
    profile_hash: &str,
) -> Result<()> {
    let conn = catalog::open(db_path)?;
    catalog::set_verdict(&conn, path, verdict, profile_hash)
}

/// Cached Home-card stats derived from a manifest: design count + panel size
/// (mm). Panel size is `None` until the blank is configured.
fn manifest_stats(m: &Manifest) -> (i64, Option<f64>, Option<f64>) {
    let count = m.designs.len() as i64;
    let (w, h) = match &m.panel {
        Some(p) => (Some(p.width_mm as f64), Some(p.height_mm as f64)),
        None => (None, None),
    };
    (count, w, h)
}

/// Refresh the cached Home-card stats (design count + panel size) for a project
/// already in the catalog, WITHOUT bumping its `last_opened_at`. Called on
/// autosave so editing designs/panel keeps the Home list accurate but doesn't
/// reorder it. Best-effort: a no-op if the project isn't catalogued.
pub fn refresh_recent_stats(db_path: &Path, container: &Path) -> Result<()> {
    let manifest = container::read_manifest(container)?;
    let (count, w, h) = manifest_stats(&manifest);
    let conn = catalog::open(db_path)?;
    catalog::update_stats(&conn, &container.to_string_lossy(), count, w, h)
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
    let (count, w, h) = manifest_stats(&manifest);
    let conn = catalog::open(db_path)?;
    catalog::upsert(
        &conn,
        &container.to_string_lossy(),
        &manifest.name,
        count,
        w,
        h,
        now,
    )?;
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

/// Atomically reserve a fresh `design-N` directory under the working dir's
/// `gerbers/` folder: scan for the current max `N`, then `create_dir` (fails if it
/// already exists) and retry on collision. The create is the reservation, so two
/// concurrent imports can never pick the same id. Filesystem-derived (not
/// manifest-derived) so an undone-then-re-added design — whose bytes are kept on
/// disk — never reuses a live id. Returns the id and its (now-created) dir.
fn reserve_design_dir(workdir: &Path) -> Result<(String, PathBuf)> {
    let gerbers_dir = workdir.join("gerbers");
    std::fs::create_dir_all(&gerbers_dir)?;

    let mut next = 1u32;
    if let Ok(rd) = std::fs::read_dir(&gerbers_dir) {
        for ent in rd.flatten() {
            if !ent.path().is_dir() {
                continue;
            }
            let name = ent.file_name();
            let name = name.to_string_lossy();
            if let Some(n) = name
                .strip_prefix("design-")
                .and_then(|s| s.parse::<u32>().ok())
            {
                let after = n
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("design id overflow"))?;
                next = next.max(after);
            }
        }
    }

    loop {
        let id = format!("design-{next}");
        let dir = gerbers_dir.join(&id);
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok((id, dir)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                next = next
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("design id overflow"))?;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Add one source ZIP as a new Design directly inside an open project's working
/// dir: copy each gerber to `gerbers/<new-id>/<name>` (deduping basenames),
/// classify it by filename, and return the [`manifest::Design`] for the caller to
/// merge into the manifest. Does NOT touch the manifest or the `.cuprum` — the UI
/// merges the returned design and persists through the normal autosave path.
pub fn add_design_to_workdir(workdir: &Path, zip_path: &Path) -> Result<manifest::Design> {
    let imported = import::read_zip_gerbers(zip_path)?;
    if imported.gerbers.is_empty() {
        anyhow::bail!("no recognisable Gerber/drill files found in the ZIP");
    }
    // Reserve the id by creating its dir atomically (after the empty-zip check, so
    // a junk ZIP never leaves a stray empty design dir behind).
    let (id, design_dir) = reserve_design_dir(workdir)?;

    let mut gerbers = Vec::new();
    let mut used = std::collections::HashSet::new();
    {
        let _s = tracing::info_span!("write_gerbers", files = imported.gerbers.len()).entered();
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

    let (count, w, h) = manifest_stats(&manifest);
    let conn = catalog::open(db_path)?;
    catalog::upsert(&conn, &save_path.to_string_lossy(), name, count, w, h, now)?;
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
    let (count, w, h) = manifest_stats(&manifest);
    let conn = catalog::open(db_path)?;
    catalog::upsert(
        &conn,
        &container.to_string_lossy(),
        &manifest.name,
        count,
        w,
        h,
        now,
    )?;
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

    let (count, w, h) = manifest_stats(&manifest);
    let conn = catalog::open(db_path)?;
    catalog::upsert(
        &conn,
        &container.to_string_lossy(),
        &manifest.name,
        count,
        w,
        h,
        now,
    )?;
    Ok(manifest)
}

/// Read the manifest straight from a `.cuprum` container, without extracting a
/// working dir — used to prefill the recents "edit name/description" dialog for a
/// project that isn't open.
pub fn read_project_manifest(container: &Path) -> Result<Manifest> {
    ensure_project_exists(container)?;
    container::read_manifest(container).map_err(|e| {
        if !container.exists() {
            anyhow::anyhow!(PROJECT_NOT_FOUND)
        } else {
            e
        }
    })
}

/// Read the panel blank from the manifest, or `None` if not yet configured.
pub fn read_panel(container: &Path) -> Result<Option<PanelDoc>> {
    ensure_project_exists(container)?;
    Ok(container::read_manifest(container)?.panel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    use crate::test_trace::collect_span_names;

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
    fn add_design_emits_write_gerbers_span() {
        let dir = std::env::temp_dir().join(format!("cuprum-add-span-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        let zip = dir.join("board.zip");
        {
            let f = std::fs::File::create(&zip).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("board-F_Cu.gbr", o).unwrap();
            z.write_all(b"G04 cu*").unwrap();
            z.finish().unwrap();
        }
        let wd = dir.join("wd");
        std::fs::create_dir_all(&wd).unwrap();
        crate::document::workdir::write_manifest(&wd, &Manifest::new("demo")).unwrap();

        let (result, names) = collect_span_names(|| add_design_to_workdir(&wd, &zip));
        result.unwrap();
        assert!(
            names.contains(&"write_gerbers".to_string()),
            "expected write_gerbers span, got: {names:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
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
        crate::document::workdir::write_manifest(&wd, &Manifest::new("demo")).unwrap();

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
    fn add_design_to_workdir_rejects_zip_without_gerbers() {
        let dir = std::env::temp_dir().join(format!("cuprum-add-empty-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let zip = dir.join("docs.zip");
        {
            use std::io::Write;
            use zip::write::SimpleFileOptions;
            let f = std::fs::File::create(&zip).unwrap();
            let mut z = zip::ZipWriter::new(f);
            z.start_file("readme.txt", SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        let wd = dir.join("wd");
        std::fs::create_dir_all(&wd).unwrap();
        crate::document::workdir::write_manifest(&wd, &Manifest::new("demo")).unwrap();
        assert!(add_design_to_workdir(&wd, &zip).is_err());
        assert!(!wd.join("gerbers/design-1").exists());
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
    fn reimport_preserves_stackup() {
        use crate::document::manifest::Stackup;
        use crate::document::panel::PanelDoc;
        let dir = std::env::temp_dir().join(format!("cuprum-reimp-stk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let save = dir.join("proj.cuprum");
        create_project(&db, &save, "proj", &[], 1000).unwrap();

        // Seed a stackup + panel on the container manifest (the live app does this
        // through the working-dir + autosave path, not a dedicated command).
        let mut m = container::read_manifest(&save).unwrap();
        m.stackup = Some(Stackup {
            copper_weight_oz: 1.0,
            substrate_thickness_mm: 1.6,
            double_sided: true,
        });
        m.panel = Some(PanelDoc::new(150.0, 100.0));
        container::update_manifest(&save, &m).unwrap();

        // A reimport (here: zero new zips) must not wipe the stackup.
        let m = import_zips(&db, &save, &[], 3000).unwrap();
        assert!(m.stackup.as_ref().unwrap().double_sided);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_migrates_legacy_panel_json() {
        use crate::document::panel::PanelDoc;
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
