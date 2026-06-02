//! Restore points: document snapshots kept inside the working dir under
//! `history/<id>.json`. They ride into/out of the `.cuprum` via the normal
//! `workdir::pack`/`extract` (which carry every file except the manifest and the
//! session marker). The embedded `manifest` is stored as a raw JSON `Value` so
//! snapshots written by older app versions survive schema upgrades; callers must
//! read through `migrate::manifest_from_value` (done by `history::read`).

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::document::manifest::Manifest;

/// Legacy restore points (written before retention v2) have no `auto` field.
/// Default them to `auto = true` so the smart prune can thin pre-existing history
/// — before this feature, manual saves were also label-less, so an old manual
/// point is indistinguishable from an auto one; treating legacy as auto lets
/// accumulated bloat be discharged. New points carry an explicit flag.
fn default_true() -> bool {
    true
}

/// A persisted document snapshot: metadata plus the full manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    pub label: Option<String>,
    pub created_at: i64,
    #[serde(default = "default_true")]
    pub auto: bool,
    pub manifest: Value,
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

/// Reject ids that aren't a bare filename token (no path separators, `..`, or
/// `:`) so a restore-point id can never escape the `history/` directory.
/// The colon check blocks Windows drive-relative forms like `C:foo` for which
/// `Path::join` would discard the `history/` base entirely.
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains(':')
        || id.contains("..")
    {
        anyhow::bail!("invalid restore point id: {id:?}");
    }
    Ok(())
}

/// Snapshot the working dir's current manifest into `history/<id>.json`, then
/// prune via the retention policy. The manifest is migrated before being stored,
/// so snapshots are always written at the current schema version.
/// Returns the new point's metadata.
pub fn write(
    workdir: &Path,
    id: &str,
    label: Option<&str>,
    created_at: i64,
    auto: bool,
) -> Result<RestorePointMeta> {
    validate_id(id)?;
    let manifest = crate::document::workdir::read_manifest(workdir)?;
    let point = RestorePoint {
        id: id.to_string(),
        label: label.map(|s| s.to_string()),
        created_at,
        auto,
        manifest: serde_json::to_value(&manifest)?,
    };
    let dir = history_dir(workdir);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&point)?,
    )?;
    prune(workdir, created_at)?;
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

/// The manifest captured by restore point `id`, migrated to the current schema.
pub fn read(workdir: &Path, id: &str) -> Result<Manifest> {
    validate_id(id)?;
    let bytes = fs::read(history_dir(workdir).join(format!("{id}.json")))?;
    let point: RestorePoint = serde_json::from_slice(&bytes)?;
    crate::document::migrate::manifest_from_value(point.manifest)
}

/// Retention constants. Auto points are thinned by a GFS-style time ladder;
/// manual points are kept up to a generous cap.
const MAX_MANUAL_POINTS: usize = 100;
const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;
const KEEP_ALL_AUTO: i64 = DAY; // auto points younger than this are all kept
const DAILY_UNTIL: i64 = WEEK; // [1d, 7d): keep newest per calendar day
const WEEKLY_UNTIL: i64 = 8 * WEEK; // [7d, 8wk): keep newest per week; older dropped
const STALE_AUTO_HORIZON: i64 = 2 * DAY; // stale auto older than this is dropped

/// Pure inputs for the retention decision (no IO).
#[derive(Debug, Clone)]
pub struct PruneInfo {
    pub id: String,
    pub created_at: i64,
    pub auto: bool,
    /// Design ids this snapshot references (migrated). `Some(set)` lists the
    /// references (empty set = references nothing); `None` means the snapshot
    /// could not be migrated (e.g. written by a newer app version) — callers
    /// must fail toward RETENTION (never staleness-prune an unreadable point;
    /// normal age-based thinning still applies).
    pub design_ids: Option<BTreeSet<String>>,
}

/// Decide which restore-point ids to delete. Pure + deterministic.
///
/// - Manual (`!auto`): never time-thinned; only the oldest beyond
///   `MAX_MANUAL_POINTS` are dropped.
/// - Auto: GFS ladder — keep all younger than `KEEP_ALL_AUTO`, then the newest
///   per calendar day until `DAILY_UNTIL`, then the newest per week until
///   `WEEKLY_UNTIL`, then drop. A "stale" auto point (references no design still
///   in the project) is dropped once older than `STALE_AUTO_HORIZON`, regardless
///   of the ladder — low value and it pins orphaned gerbers.
pub fn select_pruned(
    points: &[PruneInfo],
    current_designs: &BTreeSet<String>,
    now: i64,
) -> Vec<String> {
    let mut to_delete = Vec::new();

    let mut manual: Vec<&PruneInfo> = points.iter().filter(|p| !p.auto).collect();
    manual.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    for p in manual.iter().skip(MAX_MANUAL_POINTS) {
        to_delete.push(p.id.clone());
    }

    let mut auto: Vec<&PruneInfo> = points.iter().filter(|p| p.auto).collect();
    auto.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let mut seen: HashSet<(u8, i64)> = HashSet::new();
    for p in auto {
        let age = now - p.created_at;
        let stale = matches!(&p.design_ids, Some(ids) if current_designs.is_disjoint(ids));
        if stale && age >= STALE_AUTO_HORIZON {
            to_delete.push(p.id.clone());
            continue;
        }
        if age < KEEP_ALL_AUTO {
            continue;
        }
        if age < DAILY_UNTIL {
            if !seen.insert((1, age / DAY)) {
                to_delete.push(p.id.clone());
            }
            continue;
        }
        if age < WEEKLY_UNTIL {
            if !seen.insert((2, age / WEEK)) {
                to_delete.push(p.id.clone());
            }
            continue;
        }
        to_delete.push(p.id.clone());
    }
    to_delete
}

/// Design ids referenced by a snapshot's manifest, migrated to the current
/// schema. `Some(set)` lists the references (empty set = references nothing);
/// `None` means the snapshot could not be migrated (e.g. written by a newer app
/// version) — callers must fail toward RETENTION (never staleness-prune an
/// unreadable point; normal age-based thinning still applies).
fn point_design_ids(value: &Value) -> Option<BTreeSet<String>> {
    crate::document::migrate::manifest_from_value(value.clone())
        .ok()
        .map(|m| m.designs.into_iter().map(|d| d.id).collect())
}

/// Apply the retention policy (see `select_pruned`). `now` is the current epoch
/// (the just-written point's `created_at`). Reads each point's `auto` + design ids
/// and the live manifest's design set.
fn prune(workdir: &Path, now: i64) -> Result<()> {
    let dir = history_dir(workdir);
    if !dir.exists() {
        return Ok(());
    }
    let mut infos: Vec<PruneInfo> = Vec::new();
    for ent in fs::read_dir(&dir)? {
        let path = ent?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(p) = serde_json::from_slice::<RestorePoint>(&bytes) else {
            continue;
        };
        infos.push(PruneInfo {
            id: p.id,
            created_at: p.created_at,
            auto: p.auto,
            design_ids: point_design_ids(&p.manifest),
        });
    }
    let current: BTreeSet<String> = match crate::document::workdir::read_manifest(workdir) {
        Ok(m) => m.designs.into_iter().map(|d| d.id).collect(),
        Err(_) => BTreeSet::new(),
    };
    for id in select_pruned(&infos, &current, now) {
        fs::remove_file(dir.join(format!("{id}.json"))).ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::manifest::Manifest;

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

        let a = write(&wd, "rp-1", Some("first"), 1000, true).unwrap();
        m.name = "changed".into();
        std::fs::write(wd.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let b = write(&wd, "rp-2", None, 2000, true).unwrap();

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
            serde_json::to_vec(&crate::document::manifest::Manifest::new("x")).unwrap(),
        )
        .unwrap();
        assert!(write(&wd, "../escape", None, 1, true).is_err());
        assert!(write(&wd, "a/b", None, 1, true).is_err());
        assert!(read(&wd, "../escape").is_err());
        // Windows drive-relative form must also be rejected.
        assert!(write(&wd, "C:evil", None, 1, true).is_err());
        // A normal generated-style id still works.
        assert!(write(&wd, "rp-100-0", None, 1, true).is_ok());
    }

    #[test]
    fn prune_keeps_manual_and_fresh_auto() {
        let wd = scratch("prune-smart");
        let m = Manifest::new("demo");
        std::fs::write(wd.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let now = 100 * DAY;
        // Old manual → kept; fresh auto → kept; ancient auto (>8wk) → pruned.
        write(&wd, "manual-old", Some("milestone"), now - 40 * DAY, false).unwrap();
        write(&wd, "auto-fresh", None, now - HOUR, true).unwrap();
        write(&wd, "auto-ancient", None, now - 60 * DAY, true).unwrap();
        // Re-run prune deterministically at `now` (write already pruned at its own
        // created_at; call once more so all three are evaluated against the same now).
        prune(&wd, now).unwrap();
        let ids: std::collections::HashSet<String> =
            list(&wd).unwrap().into_iter().map(|m| m.id).collect();
        assert!(ids.contains("manual-old"), "manual kept regardless of age");
        assert!(ids.contains("auto-fresh"), "fresh auto kept");
        assert!(
            !ids.contains("auto-ancient"),
            "auto older than 8 weeks pruned"
        );
    }

    #[test]
    fn auto_defaults_true_for_legacy_points() {
        // A legacy point JSON without the `auto` field must deserialize as auto=true.
        let legacy = r#"{"id":"rp-old","label":null,"createdAt":1000,"manifest":{}}"#;
        let p: RestorePoint = serde_json::from_str(legacy).unwrap();
        assert!(
            p.auto,
            "legacy point (no `auto` field) defaults to auto=true"
        );
        let np = RestorePoint {
            id: "x".into(),
            label: None,
            created_at: 1,
            auto: false,
            manifest: serde_json::json!({}),
        };
        let s = serde_json::to_string(&np).unwrap();
        assert!(!serde_json::from_str::<RestorePoint>(&s).unwrap().auto);
    }

    fn info(id: &str, created_at: i64, auto: bool, designs: &[&str]) -> PruneInfo {
        PruneInfo {
            id: id.into(),
            created_at,
            auto,
            design_ids: Some(designs.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn manual_points_survive_thinning() {
        let now = 100 * DAY;
        let pts = vec![
            info("m1", now - 50 * DAY, false, &["d1"]),
            info("m2", now - 90 * DAY, false, &["d1"]),
        ];
        let cur: std::collections::BTreeSet<String> = ["d1".to_string()].into_iter().collect();
        assert!(
            select_pruned(&pts, &cur, now).is_empty(),
            "manual points are never time-thinned"
        );
    }

    #[test]
    fn auto_recent_all_kept_old_bucketed() {
        let now = 100 * DAY;
        let cur: std::collections::BTreeSet<String> = ["d1".to_string()].into_iter().collect();
        let pts = vec![
            info("a_now1", now - HOUR, true, &["d1"]),
            info("a_now2", now - 2 * HOUR, true, &["d1"]),
            info("a_d_new", now - 2 * DAY, true, &["d1"]),
            info("a_d_old", now - 2 * DAY - 3 * HOUR, true, &["d1"]),
            info("a_ancient", now - 30 * DAY, true, &["d1"]),
            info("a_too_old", now - 60 * DAY, true, &["d1"]),
        ];
        let drop = select_pruned(&pts, &cur, now);
        assert!(
            drop.contains(&"a_d_old".to_string()),
            "older point in same day-bucket dropped"
        );
        assert!(
            drop.contains(&"a_too_old".to_string()),
            "auto older than 8 weeks dropped"
        );
        assert!(
            !drop.contains(&"a_now1".to_string()) && !drop.contains(&"a_now2".to_string()),
            "recent auto kept"
        );
        assert!(
            !drop.contains(&"a_d_new".to_string()),
            "newest in day-bucket kept"
        );
    }

    #[test]
    fn unknown_design_set_is_not_stale_pruned() {
        let now = 100 * DAY;
        let cur: std::collections::BTreeSet<String> = ["d1".to_string()].into_iter().collect();
        // Auto point, 3 days old, design set UNKNOWN (migration failed). Must NOT be
        // dropped by the 48h staleness rule. (It IS still subject to GFS week-bucketing,
        // but as the only point in its week-bucket it survives.)
        let pts = vec![PruneInfo {
            id: "unknown".into(),
            created_at: now - 3 * DAY,
            auto: true,
            design_ids: None,
        }];
        let drop = select_pruned(&pts, &cur, now);
        assert!(
            !drop.contains(&"unknown".to_string()),
            "unmigratable point not staleness-pruned"
        );
    }

    #[test]
    fn stale_auto_dropped_after_48h() {
        let now = 100 * DAY;
        let cur: std::collections::BTreeSet<String> = ["d1".to_string()].into_iter().collect();
        let pts = vec![
            info("stale_recent", now - 12 * HOUR, true, &["gone"]),
            info("stale_old", now - 3 * DAY, true, &["gone"]),
            info("live_old", now - 3 * DAY, true, &["d1"]),
        ];
        let drop = select_pruned(&pts, &cur, now);
        assert!(
            !drop.contains(&"stale_recent".to_string()),
            "stale but recent auto kept"
        );
        assert!(
            drop.contains(&"stale_old".to_string()),
            "stale auto older than 48h dropped"
        );
        assert!(
            !drop.contains(&"live_old".to_string()),
            "non-stale auto of same age kept"
        );
    }
}
