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
}

/// Open (creating if needed) the catalog DB and ensure the schema exists.
pub fn open(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS recent_projects (
            id             INTEGER PRIMARY KEY,
            path           TEXT NOT NULL UNIQUE,
            name           TEXT NOT NULL,
            last_opened_at INTEGER NOT NULL
        )",
        [],
    )?;
    Ok(conn)
}

/// Insert or update a project, bumping its `last_opened_at`.
pub fn upsert(conn: &Connection, path: &str, name: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO recent_projects (path, name, last_opened_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = ?2, last_opened_at = ?3",
        rusqlite::params![path, name, now],
    )?;
    Ok(())
}

/// List recents, most-recently-opened first; `exists` reflects the file on disk.
pub fn list(conn: &Connection) -> Result<Vec<RecentProject>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened_at FROM recent_projects ORDER BY last_opened_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let name: String = row.get(1)?;
        let last_opened_at: i64 = row.get(2)?;
        Ok((path, name, last_opened_at))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (path, name, last_opened_at) = r?;
        let exists = Path::new(&path).exists();
        out.push(RecentProject { path, name, last_opened_at, exists });
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

        upsert(&conn, "/tmp/a.cuprum", "a", 100).unwrap();
        upsert(&conn, "/tmp/b.cuprum", "b", 200).unwrap();
        upsert(&conn, "/tmp/a.cuprum", "a", 300).unwrap(); // re-open a, newer ts

        let projects = list(&conn).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "/tmp/a.cuprum"); // 300 > 200
        assert_eq!(projects[0].last_opened_at, 300);
        assert!(!projects[0].exists); // /tmp/a.cuprum doesn't exist

        remove(&conn, "/tmp/a.cuprum").unwrap();
        let remaining = list(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].path, "/tmp/b.cuprum");

        std::fs::remove_dir_all(&dir).ok();
    }
}
