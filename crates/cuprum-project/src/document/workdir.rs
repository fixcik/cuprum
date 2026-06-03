//! Per-open working directory: a `.cuprum` container is extracted here on open,
//! edited as loose files, and packed back on save. Reads/renders hit plain files
//! (no per-layer ZIP extraction) and intermediate edits are cheap.

use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::document::container::{self, MANIFEST_NAME, PANEL_NAME};
use crate::document::manifest::Manifest;

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

/// Read and migrate the live manifest from the working dir.
pub fn read_manifest(workdir: &Path) -> Result<Manifest> {
    let bytes = fs::read(workdir.join(MANIFEST_NAME))?;
    crate::document::migrate::manifest_from_slice(&bytes)
}

/// Overwrite the working dir's manifest.json (called on every doc mutation).
pub fn write_manifest(workdir: &Path, manifest: &Manifest) -> Result<()> {
    fs::write(
        workdir.join(MANIFEST_NAME),
        serde_json::to_vec_pretty(manifest)?,
    )?;
    Ok(())
}

/// Pack the working dir back into `container` atomically: the manifest plus every
/// file EXCEPT the manifest and the session marker (so panel.json + gerbers are
/// preserved). Reuses `container::write` (temp-file + atomic rename).
pub fn pack(workdir: &Path, container: &Path) -> Result<()> {
    let manifest = {
        let _s = tracing::info_span!("read_manifest").entered();
        read_manifest(workdir)?
    };
    // Sweep stale artifact blobs (post version-bump / recolor / design removal)
    // before packing, so the `.cuprum` ships only current artifacts.
    let valid = {
        let _s = tracing::info_span!("compute_valid_keys").entered();
        valid_artifact_keys(workdir, &manifest)
    };
    {
        let _s = tracing::info_span!("artifact_gc").entered();
        cuprum_core::artifact::gc(&workdir.join("artifacts"), &valid);
    }
    // Reclaim gerber dirs no live manifest/restore-point references (deleted
    // designs). Skip entirely if the live set can't be fully determined.
    {
        let _s = tracing::info_span!("gerber_gc").entered();
        if let Some(live_dirs) = live_gerber_dirs(workdir, &manifest) {
            gc_gerbers(workdir, &live_dirs);
        }
    }
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let collect_span = tracing::info_span!(
        "collect_entries",
        files = tracing::field::Empty,
        bytes = tracing::field::Empty
    );
    {
        let _s = collect_span.enter();
        collect_entries(workdir, workdir, &mut entries)?;
        collect_span.record("files", entries.len());
        collect_span.record("bytes", entries.iter().map(|(_, b)| b.len()).sum::<usize>());
    }
    container::write(container, &manifest, &entries)
}

/// The IPC/camelCase string for a manifest layer type (the repr the preview
/// command + frontend use). Keep in sync with `LayerType`'s serde rename.
fn layer_type_ipc(t: &crate::layer::LayerType) -> String {
    serde_json::to_value(t)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_string())
}

/// Content-hash keys of every artifact the current manifest still references:
/// an SVG key per gerber + a metrics key per design + a preview key per design.
/// Gerber bytes are read from the workdir; a missing/unreadable gerber is
/// skipped (its artifacts then look orphaned and get swept — correct).
fn valid_artifact_keys(workdir: &Path, manifest: &Manifest) -> std::collections::HashSet<String> {
    let mut keys = std::collections::HashSet::new();
    // Convert manifest color overrides (BTreeMap<LayerType, String>) to
    // HashMap<String, String> keyed by IPC camelCase, as preview_key expects.
    let manifest_colors: std::collections::HashMap<String, String> = manifest
        .layer_colors
        .iter()
        .map(|(lt, c)| (layer_type_ipc(lt), c.clone()))
        .collect();
    for design in &manifest.designs {
        let mut metrics_layers: Vec<(String, String, Vec<u8>)> = Vec::new();
        let mut preview_layers: Vec<cuprum_core::preview::PreviewLayer> = Vec::new();
        for g in &design.gerbers {
            let Ok(bytes) = fs::read(workdir.join(&g.path)) else {
                continue;
            };
            keys.insert(cuprum_core::cache::svg_artifact_key(&bytes));
            // Tuple order matches how project_board_metrics builds key_layers:
            // (rel, format!("{t:?}"), bytes) — rel is g.path (the same string
            // the frontend sends as GerberRef.rel after mapping g.path → rel).
            metrics_layers.push((g.path.clone(), format!("{:?}", g.layer_type), bytes.clone()));
            // Preview key: non-drill layers (the card preview has no holes),
            // colored from the manifest overrides. Must match
            // `preview::render_design_preview`.
            if !matches!(g.layer_type, crate::layer::LayerType::Drill) {
                let ipc = layer_type_ipc(&g.layer_type);
                preview_layers.push(cuprum_core::preview::PreviewLayer {
                    layer_type: ipc,
                    bytes,
                });
            }
        }
        if !metrics_layers.is_empty() {
            keys.insert(cuprum_core::cache::metrics_artifact_key(
                metrics_layers
                    .iter()
                    .map(|(rel, t, b)| (rel.as_str(), t.as_str(), b.as_slice())),
            ));
        }
        if !preview_layers.is_empty() {
            keys.insert(cuprum_core::preview::preview_key(
                &preview_layers,
                &manifest_colors,
            ));
        }
    }
    keys
}

/// Directory names (the single path component right after `gerbers/`) referenced
/// by the gerber files of a manifest's designs.
fn referenced_gerber_dirs(manifest: &Manifest, out: &mut std::collections::HashSet<String>) {
    for d in &manifest.designs {
        for g in &d.gerbers {
            let mut comps = std::path::Path::new(&g.path).components();
            if comps.next().map(|c| c.as_os_str()) == Some(std::ffi::OsStr::new("gerbers")) {
                if let Some(dir) = comps.next() {
                    out.insert(dir.as_os_str().to_string_lossy().into_owned());
                }
            }
        }
    }
}

/// All gerber dirs that must survive: referenced by the current manifest OR by
/// any restore point's (migrated) snapshot manifest. Returns `None` if the
/// restore-point set could not be fully read (a `list`/`read`/migration failure)
/// — the caller must then SKIP gerber GC, because an incomplete live set could
/// delete gerbers a still-retained point needs (fail toward retention; an
/// un-reclaimed orphan is harmless, a deleted-but-needed gerber is not).
fn live_gerber_dirs(
    workdir: &Path,
    manifest: &Manifest,
) -> Option<std::collections::HashSet<String>> {
    let mut live = std::collections::HashSet::new();
    referenced_gerber_dirs(manifest, &mut live);
    // `list` returns Ok(empty) when there's no history dir; a real IO error → None.
    let metas = crate::document::history::list(workdir).ok()?;
    for meta in metas {
        // A point we can't read/migrate (corrupt, or newer-schema snapshot) means
        // we don't know which gerbers it needs → bail and skip GC entirely.
        let snap = crate::document::history::read(workdir, &meta.id).ok()?;
        referenced_gerber_dirs(&snap, &mut live);
    }
    Some(live)
}

/// Remove `gerbers/<dir>/` directories not in `live`. Best-effort.
fn gc_gerbers(workdir: &Path, live: &std::collections::HashSet<String>) {
    let gdir = workdir.join("gerbers");
    let Ok(rd) = fs::read_dir(&gdir) else { return };
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        if !live.contains(&name) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Walk `dir` recursively, pushing (archive-relative path, bytes) for every file
/// except the manifest and the session marker. Paths use `/` separators.
fn collect_entries(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
    for ent in fs::read_dir(dir)? {
        let path = ent?.path();
        if path.is_dir() {
            collect_entries(root, &path, out)?;
            continue;
        }
        let rel = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        if rel == MANIFEST_NAME || rel == SESSION_MARKER || rel == PANEL_NAME {
            continue;
        }
        out.push((rel, fs::read(&path)?));
    }
    Ok(())
}

/// An abandoned working dir found at startup: its source container and whether
/// it holds unsaved changes worth recovering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub workdir: String,
    pub source_path: String,
    pub dirty: bool,
}

/// Scan `base` for child working dirs (each carrying a session marker) NOT owned
/// by `live_pid`. `dirty` is true when the loose manifest differs from the source
/// container's manifest (or the source is gone/corrupt) — i.e. recoverable.
pub fn scan_orphans(base: &Path, live_pid: u32) -> Result<Vec<Orphan>> {
    let mut out = Vec::new();
    if !base.exists() {
        return Ok(out);
    }
    for ent in fs::read_dir(base)? {
        let wd = ent?.path();
        if !wd.is_dir() {
            continue;
        }
        let marker = match read_marker(&wd) {
            Ok(m) => m,
            Err(_) => continue, // not a working dir
        };
        if marker.pid == live_pid {
            continue;
        }
        let working_manifest = match read_manifest(&wd) {
            Ok(m) => m,
            Err(_) => continue, // unusable
        };
        let source = Path::new(&marker.source_path);
        let dirty = match container::read_manifest(source) {
            Ok(saved) => saved != working_manifest,
            Err(_) => true, // source missing/corrupt -> treat as recoverable
        };
        out.push(Orphan {
            workdir: wd.to_string_lossy().to_string(),
            source_path: marker.source_path.clone(),
            dirty,
        });
    }
    Ok(out)
}

/// Delete every orphan working dir under `base` that is NOT dirty (no unsaved
/// changes) and not owned by `live_pid`. Dirty ones are left for recovery.
/// All clean orphans are attempted even if one fails; the first removal error
/// is returned after the full sweep.
pub fn gc_clean(base: &Path, live_pid: u32) -> Result<()> {
    let mut first_err: Option<anyhow::Error> = None;
    for o in scan_orphans(base, live_pid)? {
        if !o.dirty {
            if let Err(e) = fs::remove_dir_all(&o.workdir) {
                if first_err.is_none() {
                    first_err = Some(anyhow::anyhow!("failed to remove {}: {e}", o.workdir));
                }
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

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

    use crate::test_trace::collect_span_names;

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
    fn manifest_round_trips_loose() {
        use crate::document::manifest::Manifest;
        let wd = scratch("loose");

        let mut m = Manifest::new("demo");
        m.description = "hi".into();
        write_manifest(&wd, &m).unwrap();
        assert_eq!(read_manifest(&wd).unwrap(), m);

        std::fs::remove_dir_all(&wd).ok();
    }

    #[test]
    fn extract_lays_out_loose_files() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
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
        let marker = SessionMarker {
            source_path: cuprum.to_string_lossy().into(),
            pid: 1,
            opened_at: 7,
        };
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
        container::write(&cuprum, &crate::document::manifest::Manifest::new("x"), &[]).unwrap();
        let wd = root.join("wd");
        std::fs::create_dir_all(&wd).unwrap();
        let marker = SessionMarker {
            source_path: cuprum.to_string_lossy().into(),
            pid: 1,
            opened_at: 0,
        };
        assert!(extract(&cuprum, &wd, &marker).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_drops_marker_and_legacy_panel() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let root = scratch("pack");
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
            &[("gerbers/design-1/a.gbr".to_string(), b"BYTES".to_vec())],
        )
        .unwrap();

        let wd = root.join("wd");
        let marker = SessionMarker {
            source_path: cuprum.to_string_lossy().into(),
            pid: 1,
            opened_at: 0,
        };
        extract(&cuprum, &wd, &marker).unwrap();

        let mut edited = read_manifest(&wd).unwrap();
        edited.name = "renamed".into();
        write_manifest(&wd, &edited).unwrap();
        // Simulate a stray legacy panel.json sitting in the working dir.
        std::fs::write(wd.join(container::PANEL_NAME), b"{}").unwrap();

        let out = root.join("out.cu");
        pack(&wd, &out).unwrap();

        assert_eq!(container::read_manifest(&out).unwrap().name, "renamed");
        assert_eq!(
            container::read_entry(&out, "gerbers/design-1/a.gbr").unwrap(),
            b"BYTES"
        );
        assert!(container::read_entry(&out, SESSION_MARKER).is_err());
        assert!(
            container::read_entry(&out, container::PANEL_NAME).is_err(),
            "legacy panel.json must not be packed"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_emits_phase_spans() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let root = scratch("pack-spans");
        let cuprum = root.join("p.cu");

        let mut m = Manifest::new("span-test");
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
            &[("gerbers/design-1/a.gbr".to_string(), b"G04*".to_vec())],
        )
        .unwrap();

        let wd = root.join("wd");
        let marker = SessionMarker {
            source_path: cuprum.to_string_lossy().into(),
            pid: 1,
            opened_at: 0,
        };
        extract(&cuprum, &wd, &marker).unwrap();

        let out = root.join("out.cu");
        let (result, names) = collect_span_names(|| pack(&wd, &out));
        result.unwrap();

        for expected in &[
            "read_manifest",
            "compute_valid_keys",
            "artifact_gc",
            "gerber_gc",
            "collect_entries",
            "zip_write",
        ] {
            assert!(
                names.contains(&expected.to_string()),
                "expected span '{expected}', got: {names:?}"
            );
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_gcs_orphan_artifacts() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let base = std::env::temp_dir().join(format!("cuprum-packgc-{}", std::process::id()));
        let wd = base.join("wd");
        std::fs::create_dir_all(wd.join("gerbers/design-1")).unwrap();
        std::fs::create_dir_all(wd.join("artifacts/svg")).unwrap();

        let gbr = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";
        std::fs::write(wd.join("gerbers/design-1/a.gbr"), gbr).unwrap();

        // Valid svg artifact (key matches the referenced gerber) + an orphan blob.
        let valid_key = cuprum_core::cache::svg_artifact_key(gbr);
        std::fs::write(wd.join(format!("artifacts/svg/{valid_key}.bin")), b"valid").unwrap();
        std::fs::write(wd.join("artifacts/svg/deadbeef.bin"), b"orphan").unwrap();

        // Minimal manifest: one design referencing the one gerber.
        let mut manifest = Manifest::new("gc-test");
        manifest.designs.push(Design {
            id: "design-1".into(),
            source_name: "test.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/a.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        });
        write_manifest(&wd, &manifest).unwrap();

        let container = base.join("out.cuprum");
        pack(&wd, &container).unwrap();

        assert!(
            !wd.join("artifacts/svg/deadbeef.bin").exists(),
            "orphan swept by gc"
        );
        assert!(
            wd.join(format!("artifacts/svg/{valid_key}.bin")).exists(),
            "valid kept"
        );
        let packed = crate::document::container::read_entry(
            &container,
            &format!("artifacts/svg/{valid_key}.bin"),
        )
        .unwrap();
        assert_eq!(packed, b"valid", "valid artifact shipped inside .cuprum");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pack_keeps_valid_preview_blob() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let base = std::env::temp_dir().join(format!("cuprum-packprev-{}", std::process::id()));
        let wd = base.join("wd");
        std::fs::create_dir_all(wd.join("gerbers/design-1")).unwrap();
        std::fs::create_dir_all(wd.join("artifacts/preview")).unwrap();
        let gbr = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";
        std::fs::write(wd.join("gerbers/design-1/a.gbr"), gbr).unwrap();

        // Build the preview key the SAME way the implementation will: one non-drill
        // layer (topCopper), colors from the (empty) manifest overrides.
        let layers = vec![cuprum_core::preview::PreviewLayer {
            layer_type: "topCopper".to_string(),
            bytes: gbr.to_vec(),
        }];
        let colors = std::collections::HashMap::new();
        let pkey = cuprum_core::preview::preview_key(&layers, &colors);
        std::fs::write(wd.join(format!("artifacts/preview/{pkey}.bin")), b"png").unwrap();
        std::fs::write(wd.join("artifacts/preview/orphan.bin"), b"stale").unwrap();

        // Manifest: one design, one topCopper gerber, no layer_colors override.
        let mut manifest = Manifest::new("prev-test");
        manifest.designs.push(Design {
            id: "design-1".into(),
            source_name: "test.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/design-1/a.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        });
        write_manifest(&wd, &manifest).unwrap();

        pack(&wd, &base.join("out.cuprum")).unwrap();
        assert!(
            wd.join(format!("artifacts/preview/{pkey}.bin")).exists(),
            "valid preview kept"
        );
        assert!(
            !wd.join("artifacts/preview/orphan.bin").exists(),
            "orphan preview swept"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pack_reclaims_orphan_gerber_dirs() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let base = std::env::temp_dir().join(format!("cuprum-gerbgc-{}", std::process::id()));
        let wd = base.join("wd");
        for d in ["live/sub", "pinned", "dead"] {
            std::fs::create_dir_all(wd.join("gerbers").join(d)).unwrap();
        }
        let gbr = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";
        std::fs::write(wd.join("gerbers/live/sub/a.gbr"), gbr).unwrap();
        std::fs::write(wd.join("gerbers/pinned/b.gbr"), gbr).unwrap();
        std::fs::write(wd.join("gerbers/dead/c.gbr"), gbr).unwrap();

        // Live manifest references design "live".
        let mut m = Manifest::new("demo");
        m.designs = vec![Design {
            id: "live".into(),
            source_name: "live.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/live/sub/a.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        }];
        write_manifest(&wd, &m).unwrap();

        // A restore point whose snapshot references design "pinned".
        std::fs::create_dir_all(wd.join("history")).unwrap();
        let mut pm = Manifest::new("demo");
        pm.designs = vec![Design {
            id: "pinned".into(),
            source_name: "pinned.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/pinned/b.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        }];
        let snap = serde_json::json!({
            "id": "rp1",
            "label": null,
            "createdAt": 1,
            "auto": true,
            "manifest": serde_json::to_value(&pm).unwrap()
        });
        std::fs::write(
            wd.join("history/rp1.json"),
            serde_json::to_vec(&snap).unwrap(),
        )
        .unwrap();

        pack(&wd, &base.join("out.cuprum")).unwrap();

        assert!(
            wd.join("gerbers/live").exists(),
            "current-manifest design kept"
        );
        assert!(
            wd.join("gerbers/pinned").exists(),
            "restore-point-referenced design kept"
        );
        assert!(
            !wd.join("gerbers/dead").exists(),
            "orphan gerber dir reclaimed"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pack_skips_gerber_gc_when_a_restore_point_is_unreadable() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;
        let base = std::env::temp_dir().join(format!("cuprum-gerbgc-safe-{}", std::process::id()));
        let wd = base.join("wd");
        std::fs::create_dir_all(wd.join("gerbers/live")).unwrap();
        std::fs::create_dir_all(wd.join("gerbers/orphan")).unwrap();
        let gbr = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";
        std::fs::write(wd.join("gerbers/live/a.gbr"), gbr).unwrap();
        std::fs::write(wd.join("gerbers/orphan/b.gbr"), gbr).unwrap();

        // Live manifest references only "live".
        let mut m = Manifest::new("demo");
        m.designs = vec![Design {
            id: "live".into(),
            source_name: "live.zip".into(),
            gerbers: vec![GerberFile {
                path: "gerbers/live/a.gbr".into(),
                layer_type: LayerType::TopCopper,
            }],
        }];
        write_manifest(&wd, &m).unwrap();

        // A restore point whose snapshot manifest fails to migrate (future schema).
        std::fs::create_dir_all(wd.join("history")).unwrap();
        let snap = serde_json::json!({
            "id": "rp-future",
            "label": null,
            "createdAt": 1,
            "auto": true,
            "manifest": { "schema_version": 99999 }
        });
        std::fs::write(
            wd.join("history/rp-future.json"),
            serde_json::to_vec(&snap).unwrap(),
        )
        .unwrap();

        pack(&wd, &base.join("out.cuprum")).unwrap();

        // GC was skipped (unreadable point) → BOTH dirs survive, including the
        // would-be orphan. Fail toward retention.
        assert!(wd.join("gerbers/live").exists(), "live design kept");
        assert!(
            wd.join("gerbers/orphan").exists(),
            "GC skipped when a point is unreadable — orphan NOT deleted"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pack_includes_artifacts_with_valid_keys() {
        use crate::document::manifest::{Design, GerberFile, Manifest};
        use crate::layer::LayerType;

        let base = std::env::temp_dir().join(format!("cuprum-pack-art-{}", std::process::id()));
        let wd = base.join("wd");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(wd.join("gerbers/d1")).unwrap();

        let gerber_bytes: &[u8] = b"%FSLAX26Y26*%\nM02*\n";
        let gerber_rel = "gerbers/d1/x.gbr";
        std::fs::write(wd.join(gerber_rel), gerber_bytes).unwrap();

        // Build a manifest with one design referencing the gerber as TopCopper.
        let mut manifest = Manifest::new("art-pack-test");
        manifest.designs.push(Design {
            id: "d1".into(),
            source_name: "test.zip".into(),
            gerbers: vec![GerberFile {
                path: gerber_rel.into(),
                layer_type: LayerType::TopCopper,
            }],
        });
        write_manifest(&wd, &manifest).unwrap();

        // Place a dummy SVG artifact blob keyed to the gerber content.
        let key = cuprum_core::cache::svg_artifact_key(gerber_bytes);
        std::fs::create_dir_all(wd.join("artifacts/svg")).unwrap();
        std::fs::write(wd.join(format!("artifacts/svg/{key}.bin")), b"dummy-svg").unwrap();

        // Pack the working dir into a container.
        let container = base.join("out.cuprum");
        pack(&wd, &container).unwrap();

        // Extract into a fresh destination and verify the artifact is present.
        let dest = base.join("dest");
        let marker = SessionMarker {
            source_path: container.to_string_lossy().into(),
            pid: std::process::id(),
            opened_at: 0,
        };
        extract(&container, &dest, &marker).unwrap();

        assert!(
            dest.join(format!("artifacts/svg/{key}.bin")).exists(),
            "valid SVG artifact must survive gc and be present after extract"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn scan_flags_dirty_and_gc_removes_clean() {
        use crate::document::manifest::Manifest;
        let root = scratch("orphan");
        let base = root.join("base");
        std::fs::create_dir_all(&base).unwrap();

        // Two saved containers.
        let cu_clean = root.join("clean.cu");
        let cu_dirty = root.join("dirty.cu");
        container::write(&cu_clean, &Manifest::new("clean"), &[]).unwrap();
        container::write(&cu_dirty, &Manifest::new("dirty"), &[]).unwrap();

        // Working dirs owned by a DEAD pid (9999).
        let wd_clean = base.join("a");
        let wd_dirty = base.join("b");
        extract(
            &cu_clean,
            &wd_clean,
            &SessionMarker {
                source_path: cu_clean.to_string_lossy().into(),
                pid: 9999,
                opened_at: 0,
            },
        )
        .unwrap();
        extract(
            &cu_dirty,
            &wd_dirty,
            &SessionMarker {
                source_path: cu_dirty.to_string_lossy().into(),
                pid: 9999,
                opened_at: 0,
            },
        )
        .unwrap();

        // Make wd_dirty actually differ from its source.
        let mut edited = read_manifest(&wd_dirty).unwrap();
        edited.name = "dirty-edited".into();
        write_manifest(&wd_dirty, &edited).unwrap();

        // Live pid 9999 -> excluded entirely.
        assert!(scan_orphans(&base, 9999).unwrap().is_empty());

        // From a different pid, both are orphans; only the dirty one is recoverable.
        let orphans = scan_orphans(&base, 1).unwrap();
        assert_eq!(orphans.len(), 2);
        let dirty: Vec<_> = orphans.iter().filter(|o| o.dirty).collect();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].source_path, cu_dirty.to_string_lossy());

        // GC removes clean orphans, keeps dirty ones.
        gc_clean(&base, 1).unwrap();
        assert!(!wd_clean.exists());
        assert!(wd_dirty.exists());

        std::fs::remove_dir_all(&root).ok();
    }
}
