//! Restore points: document snapshots kept inside the working dir under
//! `history/<id>.json`. They ride into/out of the `.cuprum` via the normal
//! `workdir::pack`/`extract` (which carry every file except the manifest and the
//! session marker). A snapshot IS a `Manifest` (the whole document since the
//! panel folded in).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::manifest::Manifest;

/// Max retained restore points; oldest beyond this are pruned on each write.
pub const MAX_RESTORE_POINTS: usize = 50;

/// A persisted document snapshot: metadata plus the full manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub manifest: Manifest,
}

/// Lightweight listing entry (no manifest body).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointMeta {
    pub id: String,
    pub label: Option<String>,
    pub created_at: i64,
}

fn history_dir(workdir: &Path) -> PathBuf {
    workdir.join("history")
}

/// Reject ids that aren't a bare filename token (no path separators / `..`), so a
/// restore-point id can never escape the `history/` directory.
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        anyhow::bail!("invalid restore point id: {id:?}");
    }
    Ok(())
}

/// Snapshot the working dir's current manifest into `history/<id>.json`, then
/// prune to the newest `MAX_RESTORE_POINTS`. Returns the new point's metadata.
pub fn write(
    workdir: &Path,
    id: &str,
    label: Option<&str>,
    created_at: i64,
) -> Result<RestorePointMeta> {
    validate_id(id)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(workdir.join("manifest.json"))?)?;
    let point = RestorePoint {
        id: id.to_string(),
        label: label.map(|s| s.to_string()),
        created_at,
        manifest,
    };
    let dir = history_dir(workdir);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&point)?,
    )?;
    prune(workdir)?;
    Ok(RestorePointMeta {
        id: point.id,
        label: point.label,
        created_at: point.created_at,
    })
}

/// All restore points, newest first (by `created_at`, then id).
pub fn list(workdir: &Path) -> Result<Vec<RestorePointMeta>> {
    let dir = history_dir(workdir);
    let mut metas: Vec<RestorePointMeta> = Vec::new();
    if !dir.exists() {
        return Ok(metas);
    }
    for ent in fs::read_dir(&dir)? {
        let path = ent?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(p) = serde_json::from_slice::<RestorePoint>(&bytes) {
                metas.push(RestorePointMeta {
                    id: p.id,
                    label: p.label,
                    created_at: p.created_at,
                });
            }
        }
    }
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(metas)
}

/// The manifest captured by restore point `id`.
pub fn read(workdir: &Path, id: &str) -> Result<Manifest> {
    validate_id(id)?;
    let bytes = fs::read(history_dir(workdir).join(format!("{id}.json")))?;
    let point: RestorePoint = serde_json::from_slice(&bytes)?;
    Ok(point.manifest)
}

/// Delete all but the newest `MAX_RESTORE_POINTS`.
fn prune(workdir: &Path) -> Result<()> {
    let metas = list(workdir)?; // newest-first
    let dir = history_dir(workdir);
    for m in metas.into_iter().skip(MAX_RESTORE_POINTS) {
        fs::remove_file(dir.join(format!("{}.json", m.id))).ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cuprum-hist-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_list_read_round_trip() {
        let wd = scratch("rt");
        // Working dir needs a manifest to snapshot.
        let mut m = Manifest::new("demo");
        std::fs::write(wd.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();

        let a = write(&wd, "rp-1", Some("first"), 1000).unwrap();
        m.name = "changed".into();
        std::fs::write(wd.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let b = write(&wd, "rp-2", None, 2000).unwrap();

        // Listed newest-first.
        let metas = list(&wd).unwrap();
        assert_eq!(
            metas.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
            vec![b.id.clone(), a.id.clone()]
        );
        assert_eq!(metas[1].label.as_deref(), Some("first"));

        // Each restore point captured the manifest as it was at write time.
        assert_eq!(read(&wd, "rp-1").unwrap().name, "demo");
        assert_eq!(read(&wd, "rp-2").unwrap().name, "changed");
    }

    #[test]
    fn rejects_unsafe_ids() {
        let wd = scratch("unsafe");
        std::fs::write(
            wd.join("manifest.json"),
            serde_json::to_vec(&crate::manifest::Manifest::new("x")).unwrap(),
        )
        .unwrap();
        assert!(write(&wd, "../escape", None, 1).is_err());
        assert!(write(&wd, "a/b", None, 1).is_err());
        assert!(read(&wd, "../escape").is_err());
        // A normal generated-style id still works.
        assert!(write(&wd, "rp-100-0", None, 1).is_ok());
    }

    #[test]
    fn prune_keeps_newest_max() {
        let wd = scratch("prune");
        std::fs::write(
            wd.join("manifest.json"),
            serde_json::to_vec(&Manifest::new("x")).unwrap(),
        )
        .unwrap();
        // Write MAX_RESTORE_POINTS + 5 points with increasing timestamps.
        for i in 0..(MAX_RESTORE_POINTS + 5) {
            write(&wd, &format!("rp-{i}"), None, 1000 + i as i64).unwrap();
        }
        let metas = list(&wd).unwrap();
        assert_eq!(metas.len(), MAX_RESTORE_POINTS);
        // Oldest (rp-0..rp-4) pruned; newest retained.
        assert!(metas.iter().all(|m| m.created_at >= 1005));
    }
}
