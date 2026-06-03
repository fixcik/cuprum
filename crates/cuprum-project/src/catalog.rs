//! SQLite catalog of recent projects (MRU). Not a project store — the source of
//! truth is each `.cuprum` file; this is just the Home-screen list.

use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;

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
            height_mm      REAL
        )",
        [],
    )?;
    // Migrate DBs created before the stat columns existed. ADD COLUMN is a no-op
    // error ("duplicate column name") on already-migrated DBs — swallow only that.
    for ddl in [
        "ALTER TABLE recent_projects ADD COLUMN design_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE recent_projects ADD COLUMN width_mm REAL",
        "ALTER TABLE recent_projects ADD COLUMN height_mm REAL",
    ] {
        if let Err(e) = conn.execute(ddl, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e.into());
            }
        }
    }
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

/// List recents, most-recently-opened first; `exists` reflects the file on disk.
pub fn list(conn: &Connection) -> Result<Vec<RecentProject>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened_at, design_count, width_mm, height_mm
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
}
