//! SQLite catalog of recent projects (MRU). Not a project store — the source of
//! truth is each `.cuprum` file; this is just the Home-screen list.

use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
    /// Whether the `.cuprum` file still exists on disk.
    pub exists: bool,
    /// Number of designs in the project (for the Home card footer). Cached at
    /// open/save time so the Home list needs no per-entry container read.
    pub design_count: i64,
    /// Panel blank size in mm; `None` until the panel is configured.
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
    /// Panel feasibility verdict ("ok"/"warn"/"block"), cached at the last save
    /// with a matching capability profile. `None` until first computed.
    pub panel_verdict: Option<String>,
    /// Stable hash of the capability profile used to compute `panel_verdict`.
    /// The Home card compares this to the current profile to decide freshness.
    pub profile_hash: Option<String>,
}

/// One journalled operation run (drill / exposure / milling …). Op-agnostic:
/// op-specific config + summary live in the JSON columns.
#[derive(Debug, Clone, PartialEq)]
pub struct OperationRun {
    pub run_uid: String,
    pub project_path: String,
    pub op_type: String,
    pub started_at: i64,
    /// `None` while the run is still in progress.
    pub ended_at: Option<i64>,
    /// `None` while in progress; otherwise "completed" / "stopped" / "error".
    pub outcome: Option<String>,
    /// Total work units (holes / layers / lines); `None` when not applicable.
    pub progress_total: Option<i64>,
    pub progress_done: i64,
    /// Op-specific launch config (JSON) — also the source for "repeat last".
    pub params_json: String,
    /// Op-specific outcome detail (JSON); `None` until the run finishes.
    pub summary_json: Option<String>,
}

/// Open (creating if needed) the catalog DB and ensure the schema exists.
pub fn open(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS recent_projects (
            id             INTEGER PRIMARY KEY,
            path           TEXT NOT NULL UNIQUE,
            name           TEXT NOT NULL,
            last_opened_at INTEGER NOT NULL,
            design_count   INTEGER NOT NULL DEFAULT 0,
            width_mm       REAL,
            height_mm      REAL,
            panel_verdict  TEXT,
            profile_hash   TEXT
        )",
        [],
    )?;
    // Migrate DBs created before the stat columns existed. ADD COLUMN is a no-op
    // error ("duplicate column name") on already-migrated DBs — swallow only that.
    for ddl in [
        "ALTER TABLE recent_projects ADD COLUMN design_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE recent_projects ADD COLUMN width_mm REAL",
        "ALTER TABLE recent_projects ADD COLUMN height_mm REAL",
        "ALTER TABLE recent_projects ADD COLUMN panel_verdict TEXT",
        "ALTER TABLE recent_projects ADD COLUMN profile_hash TEXT",
    ] {
        if let Err(e) = conn.execute(ddl, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e.into());
            }
        }
    }
    // Operation-run journal — one row per launched operation (drill now; exposure /
    // milling later). Op-agnostic: the type lives in `op_type`, op-specific config in
    // `params_json`. Generic columns (op_type, started_at, outcome, progress) let the
    // history list query across types without parsing JSON.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS operation_runs (
            id              INTEGER PRIMARY KEY,
            run_uid         TEXT NOT NULL UNIQUE,
            project_path    TEXT NOT NULL,
            op_type         TEXT NOT NULL,
            started_at      INTEGER NOT NULL,
            ended_at        INTEGER,
            outcome         TEXT,
            progress_total  INTEGER,
            progress_done   INTEGER NOT NULL DEFAULT 0,
            params_json     TEXT NOT NULL,
            summary_json    TEXT
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_operation_runs_project ON operation_runs(project_path)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_operation_runs_optype ON operation_runs(project_path, op_type)",
        [],
    )?;
    Ok(conn)
}

/// Insert or update a project, bumping its `last_opened_at` and refreshing its
/// cached stats (design count + panel size).
pub fn upsert(
    conn: &Connection,
    path: &str,
    name: &str,
    design_count: i64,
    width_mm: Option<f64>,
    height_mm: Option<f64>,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO recent_projects (path, name, last_opened_at, design_count, width_mm, height_mm)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(path) DO UPDATE SET
            name = ?2, last_opened_at = ?3, design_count = ?4, width_mm = ?5, height_mm = ?6",
        rusqlite::params![path, name, now, design_count, width_mm, height_mm],
    )?;
    Ok(())
}

/// Refresh only the cached stats for an existing entry, WITHOUT bumping
/// `last_opened_at` — used by autosave so editing designs/panel doesn't reorder
/// the recents list. No-op if the path isn't in the catalog.
pub fn update_stats(
    conn: &Connection,
    path: &str,
    design_count: i64,
    width_mm: Option<f64>,
    height_mm: Option<f64>,
) -> Result<()> {
    conn.execute(
        "UPDATE recent_projects SET design_count = ?2, width_mm = ?3, height_mm = ?4
         WHERE path = ?1",
        rusqlite::params![path, design_count, width_mm, height_mm],
    )?;
    Ok(())
}

/// Update only the cached panel verdict + the profile hash it was computed against,
/// WITHOUT touching `last_opened_at` or the stat columns. No-op if the path isn't
/// in the catalog yet.
pub fn set_verdict(conn: &Connection, path: &str, verdict: &str, profile_hash: &str) -> Result<()> {
    conn.execute(
        "UPDATE recent_projects SET panel_verdict = ?2, profile_hash = ?3 WHERE path = ?1",
        rusqlite::params![path, verdict, profile_hash],
    )?;
    Ok(())
}

/// List recents, most-recently-opened first; `exists` reflects the file on disk.
pub fn list(conn: &Connection) -> Result<Vec<RecentProject>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened_at, design_count, width_mm, height_mm,
                panel_verdict, profile_hash
         FROM recent_projects ORDER BY last_opened_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(RecentProject {
            path: row.get(0)?,
            name: row.get(1)?,
            last_opened_at: row.get(2)?,
            exists: false, // filled below
            design_count: row.get(3)?,
            width_mm: row.get(4)?,
            height_mm: row.get(5)?,
            panel_verdict: row.get(6)?,
            profile_hash: row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        let mut rp = r?;
        rp.exists = Path::new(&rp.path).exists();
        out.push(rp);
    }
    Ok(out)
}

/// Remove a project from the catalog (does not touch the file).
pub fn remove(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM recent_projects WHERE path = ?1", [path])?;
    Ok(())
}

// ---- Operation-run journal ----

/// Insert a row for a just-launched run (`ended_at`/`outcome` NULL until it
/// finishes). Writing on start — not only on finish — means even a crash mid-run
/// leaves a record of what was launched.
pub fn operation_run_start(
    conn: &Connection,
    run_uid: &str,
    project_path: &str,
    op_type: &str,
    started_at: i64,
    progress_total: Option<i64>,
    params_json: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO operation_runs
            (run_uid, project_path, op_type, started_at, progress_total, params_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            run_uid,
            project_path,
            op_type,
            started_at,
            progress_total,
            params_json
        ],
    )?;
    Ok(())
}

/// Finalize a run: stamp `ended_at`, `outcome`, completed count, and optional
/// summary. No-op if the `run_uid` isn't present.
pub fn operation_run_finish(
    conn: &Connection,
    run_uid: &str,
    ended_at: i64,
    outcome: &str,
    progress_done: i64,
    summary_json: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE operation_runs
            SET ended_at = ?2, outcome = ?3, progress_done = ?4, summary_json = ?5
          WHERE run_uid = ?1",
        rusqlite::params![run_uid, ended_at, outcome, progress_done, summary_json],
    )?;
    Ok(())
}

/// List runs for a project, newest first. `op_type = None` returns all types;
/// `Some(t)` filters to that type.
pub fn operation_runs_list(
    conn: &Connection,
    project_path: &str,
    op_type: Option<&str>,
) -> Result<Vec<OperationRun>> {
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<OperationRun> {
        Ok(OperationRun {
            run_uid: row.get(0)?,
            project_path: row.get(1)?,
            op_type: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            outcome: row.get(5)?,
            progress_total: row.get(6)?,
            progress_done: row.get(7)?,
            params_json: row.get(8)?,
            summary_json: row.get(9)?,
        })
    };
    const COLS: &str = "run_uid, project_path, op_type, started_at, ended_at, outcome,
                        progress_total, progress_done, params_json, summary_json";
    let mut out = Vec::new();
    match op_type {
        Some(t) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLS} FROM operation_runs
                  WHERE project_path = ?1 AND op_type = ?2 ORDER BY started_at DESC"
            ))?;
            let rows = stmt.query_map(rusqlite::params![project_path, t], map_row)?;
            for r in rows {
                out.push(r?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLS} FROM operation_runs
                  WHERE project_path = ?1 ORDER BY started_at DESC"
            ))?;
            let rows = stmt.query_map(rusqlite::params![project_path], map_row)?;
            for r in rows {
                out.push(r?);
            }
        }
    }
    Ok(out)
}

/// The `params_json` of the most recent run of `op_type` for a project — the
/// default for "repeat last" / prefill. `None` when there's no prior run.
pub fn operation_run_last_params(
    conn: &Connection,
    project_path: &str,
    op_type: &str,
) -> Result<Option<String>> {
    // `.optional()` maps only "no rows" to None — genuine DB errors propagate
    // (a silent None on a corrupt/locked DB would hide real failures).
    let r = conn
        .query_row(
            "SELECT params_json FROM operation_runs
              WHERE project_path = ?1 AND op_type = ?2 ORDER BY started_at DESC LIMIT 1",
            rusqlite::params![project_path, op_type],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_list_remove() {
        let dir = std::env::temp_dir().join(format!("cuprum-cat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let conn = open(&db).unwrap();

        upsert(&conn, "/tmp/a.cuprum", "a", 2, Some(50.0), Some(40.0), 100).unwrap();
        upsert(&conn, "/tmp/b.cuprum", "b", 0, None, None, 200).unwrap();
        upsert(&conn, "/tmp/a.cuprum", "a", 3, Some(60.0), Some(40.0), 300).unwrap(); // re-open a, newer ts

        let projects = list(&conn).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "/tmp/a.cuprum"); // 300 > 200
        assert_eq!(projects[0].last_opened_at, 300);
        assert_eq!(projects[0].design_count, 3); // stats refreshed on re-upsert
        assert_eq!(projects[0].width_mm, Some(60.0));
        assert!(!projects[0].exists); // /tmp/a.cuprum doesn't exist
        assert_eq!(projects[1].design_count, 0);
        assert_eq!(projects[1].width_mm, None);

        // update_stats refreshes counts/size without touching last_opened_at.
        update_stats(&conn, "/tmp/a.cuprum", 5, Some(70.0), Some(45.0)).unwrap();
        let after = list(&conn).unwrap();
        assert_eq!(after[0].path, "/tmp/a.cuprum"); // order unchanged (ts intact)
        assert_eq!(after[0].last_opened_at, 300);
        assert_eq!(after[0].design_count, 5);
        assert_eq!(after[0].width_mm, Some(70.0));
        assert_eq!(after[0].height_mm, Some(45.0));

        remove(&conn, "/tmp/a.cuprum").unwrap();
        let remaining = list(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].path, "/tmp/b.cuprum");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verdict_columns_survive_stats_updates() {
        let dir = std::env::temp_dir().join(format!("cuprum-verdict-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let conn = open(&db).unwrap();

        // Seed a project with no verdict yet.
        upsert(&conn, "/tmp/v.cuprum", "v", 1, Some(50.0), Some(40.0), 100).unwrap();

        // set_verdict stores the verdict and profile hash.
        set_verdict(&conn, "/tmp/v.cuprum", "warn", "abc123").unwrap();
        let projects = list(&conn).unwrap();
        assert_eq!(projects[0].panel_verdict, Some("warn".to_string()));
        assert_eq!(projects[0].profile_hash, Some("abc123".to_string()));

        // update_stats must NOT clobber the verdict columns.
        update_stats(&conn, "/tmp/v.cuprum", 3, Some(60.0), Some(45.0)).unwrap();
        let after_stats = list(&conn).unwrap();
        assert_eq!(after_stats[0].design_count, 3); // stats updated
        assert_eq!(after_stats[0].panel_verdict, Some("warn".to_string())); // verdict preserved
        assert_eq!(after_stats[0].profile_hash, Some("abc123".to_string())); // hash preserved

        // upsert (re-open) must NOT clobber the verdict columns either.
        upsert(&conn, "/tmp/v.cuprum", "v", 4, Some(70.0), Some(50.0), 200).unwrap();
        let after_upsert = list(&conn).unwrap();
        assert_eq!(after_upsert[0].last_opened_at, 200); // ts updated
        assert_eq!(after_upsert[0].panel_verdict, Some("warn".to_string())); // verdict preserved
        assert_eq!(after_upsert[0].profile_hash, Some("abc123".to_string())); // hash preserved

        // set_verdict can update to a new verdict.
        set_verdict(&conn, "/tmp/v.cuprum", "ok", "def456").unwrap();
        let final_list = list(&conn).unwrap();
        assert_eq!(final_list[0].panel_verdict, Some("ok".to_string()));
        assert_eq!(final_list[0].profile_hash, Some("def456".to_string()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn operation_runs_journal() {
        let dir = std::env::temp_dir().join(format!("cuprum-oprun-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.sqlite");
        let conn = open(&db).unwrap();

        let proj = "/tmp/p.cuprum";

        // A finished drill run.
        operation_run_start(
            &conn,
            "uid-1",
            proj,
            "drill",
            100,
            Some(120),
            "{\"feed\":100}",
        )
        .unwrap();
        // Mid-run: ended_at/outcome NULL, progress_done defaults to 0.
        let live = operation_runs_list(&conn, proj, None).unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].run_uid, "uid-1");
        assert_eq!(live[0].ended_at, None);
        assert_eq!(live[0].outcome, None);
        assert_eq!(live[0].progress_total, Some(120));
        assert_eq!(live[0].progress_done, 0);

        operation_run_finish(&conn, "uid-1", 250, "completed", 120, Some("{\"sec\":42}")).unwrap();
        let done = operation_runs_list(&conn, proj, None).unwrap();
        assert_eq!(done[0].ended_at, Some(250));
        assert_eq!(done[0].outcome, Some("completed".to_string()));
        assert_eq!(done[0].progress_done, 120);
        assert_eq!(done[0].summary_json, Some("{\"sec\":42}".to_string()));

        // A second run of a different type, newer — list is newest-first.
        operation_run_start(&conn, "uid-2", proj, "expose", 300, None, "{\"layer\":1}").unwrap();
        let all = operation_runs_list(&conn, proj, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].run_uid, "uid-2"); // 300 > 100 (started_at DESC)

        // Filter by op_type.
        let drills = operation_runs_list(&conn, proj, Some("drill")).unwrap();
        assert_eq!(drills.len(), 1);
        assert_eq!(drills[0].op_type, "drill");

        // last_params returns the most recent run's params for that type.
        operation_run_start(
            &conn,
            "uid-3",
            proj,
            "drill",
            400,
            Some(80),
            "{\"feed\":75}",
        )
        .unwrap();
        assert_eq!(
            operation_run_last_params(&conn, proj, "drill").unwrap(),
            Some("{\"feed\":75}".to_string()) // uid-3 (400) over uid-1 (100)
        );
        // No prior run of this type / project → None.
        assert_eq!(
            operation_run_last_params(&conn, proj, "milling").unwrap(),
            None
        );
        assert_eq!(
            operation_run_last_params(&conn, "/tmp/other.cuprum", "drill").unwrap(),
            None
        );

        // Runs are scoped per project.
        assert_eq!(
            operation_runs_list(&conn, "/tmp/other.cuprum", None)
                .unwrap()
                .len(),
            0
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
