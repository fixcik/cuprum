//! Local crash reporting: capture panics + frontend errors, store redacted
//! records under app_data/crashes, build GitHub-issue reports.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// One captured crash, persisted as crashes/<seq>.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CrashRecord {
    pub id: u64,
    pub ts: String,
    pub kind: String, // "rust-panic" | "frontend"
    pub version: String,
    pub os: String,
    pub message: String,
    pub location: String,
    pub backtrace: String,
    pub last_op: String,
    #[serde(default)]
    pub reported: bool,
    #[serde(default)]
    pub dismissed: bool,
}

/// Lightweight view sent to the UI for the pending-crash prompt.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct CrashSummary {
    pub id: u64,
    pub ts: String,
    pub kind: String,
    pub message: String,
}

/// Replace absolute machine paths with placeholders so a public GitHub issue
/// never leaks the user's home dir or project locations. Relative source paths
/// (e.g. cuprum-gerber/src/...) are intentionally left intact.
pub(crate) fn redact_paths(input: &str, home: &str) -> String {
    if home.is_empty() {
        return input.to_string();
    }
    input.replace(home, "/Users/<user>")
}

// ── Storage ──────────────────────────────────────────────────────────────────

/// Next sequential id = max existing + 1 (filenames are <id>.json).
// Acceptable race on simultaneous double-panic: one of two records may be lost; fine for single-user desktop.
fn next_id(dir: &Path) -> u64 {
    let mut max = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Some(stem) = e.path().file_stem().and_then(|s| s.to_str()) {
                if let Ok(n) = stem.parse::<u64>() {
                    max = max.max(n);
                }
            }
        }
    }
    max + 1
}

/// Persist a record; returns its assigned id. Infallible-by-design callers
/// (panic hook) ignore the Result.
pub(crate) fn write_record(dir: &Path, mut rec: CrashRecord) -> std::io::Result<u64> {
    fs::create_dir_all(dir)?;
    let id = next_id(dir);
    rec.id = id;
    let path = dir.join(format!("{id}.json"));
    fs::write(path, serde_json::to_vec_pretty(&rec)?)?;
    Ok(id)
}

fn read_record(path: &Path) -> Option<CrashRecord> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn all_records(dir: &Path) -> Vec<CrashRecord> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(r) = read_record(&e.path()) {
                    out.push(r);
                }
            }
        }
    }
    out.sort_by_key(|r| r.id);
    out
}

fn set_flags(dir: &Path, id: u64, reported: Option<bool>, dismissed: Option<bool>) {
    let path = dir.join(format!("{id}.json"));
    if let Some(mut r) = read_record(&path) {
        if let Some(v) = reported {
            r.reported = v;
        }
        if let Some(v) = dismissed {
            r.dismissed = v;
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&r) {
            let _ = fs::write(&path, bytes);
        }
    }
}

// ── Tauri commands + panic hook ───────────────────────────────────────────────

fn crashes_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("crashes"))
}

fn home_dir_string() -> String {
    std::env::var("HOME").unwrap_or_default()
}

fn os_string() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

/// Install a panic hook that chains to the default (console output kept) and
/// writes a redacted CrashRecord. Resolves the crashes dir once and moves it
/// into the closure — AppHandle is not reliably reachable inside the hook.
pub(crate) fn install_panic_hook<R: Runtime>(app: &AppHandle<R>) {
    let Some(dir) = crashes_dir(app) else {
        return;
    };
    let home = home_dir_string();
    let version = app.package_info().version.to_string();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        // force_capture ignores RUST_BACKTRACE so we always get a trace regardless of env.
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let rec = CrashRecord {
            id: 0,
            ts: now_iso(),
            kind: "rust-panic".into(),
            version: version.clone(),
            os: os_string(),
            message: redact_paths(&msg, &home),
            location: redact_paths(&location, &home),
            backtrace: redact_paths(&bt, &home),
            last_op: std::thread::current().name().unwrap_or("?").to_string(),
            reported: false,
            dismissed: false,
        };
        let _ = write_record(&dir, rec);
        prev(info);
    }));
}

#[tauri::command]
pub(crate) fn list_pending_crashes(app: AppHandle) -> Vec<CrashSummary> {
    let Some(dir) = crashes_dir(&app) else {
        return vec![];
    };
    all_records(&dir)
        .into_iter()
        .filter(|r| !r.reported && !r.dismissed)
        .map(|r| CrashSummary {
            id: r.id,
            ts: r.ts,
            kind: r.kind,
            message: r.message,
        })
        .collect()
}

#[tauri::command]
pub(crate) fn report_frontend_crash(
    app: AppHandle,
    message: String,
    stack: String,
    last_op: String,
) {
    let Some(dir) = crashes_dir(&app) else {
        return;
    };
    let home = home_dir_string();
    let rec = CrashRecord {
        id: 0,
        ts: now_iso(),
        kind: "frontend".into(),
        version: app.package_info().version.to_string(),
        os: os_string(),
        message: redact_paths(&message, &home),
        // JS location is embedded in the stack field.
        location: String::new(),
        backtrace: redact_paths(&stack, &home),
        last_op,
        reported: false,
        dismissed: false,
    };
    let _ = write_record(&dir, rec);
}

#[tauri::command]
pub(crate) fn mark_crash_reported(app: AppHandle, id: u64) {
    if let Some(dir) = crashes_dir(&app) {
        set_flags(&dir, id, Some(true), None);
    }
}

#[tauri::command]
pub(crate) fn dismiss_crash(app: AppHandle, id: u64) {
    if let Some(dir) = crashes_dir(&app) {
        set_flags(&dir, id, None, Some(true));
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CrashReport {
    pub id: Option<u64>,
    pub title: String,
    pub body: String,
    pub log_dir: String,
}

/// Build the GitHub-issue body (markdown) for the most recent unreported crash,
/// or an empty template if none. Caps the backtrace so the prefilled URL stays
/// under GitHub's limit.
#[tauri::command]
pub(crate) fn build_crash_report(app: AppHandle, id: Option<u64>) -> CrashReport {
    let dir = crashes_dir(&app);
    let log_dir = dir
        .as_ref()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let rec = dir.as_ref().and_then(|d| {
        let all = all_records(d);
        match id {
            Some(want) => all.into_iter().find(|r| r.id == want),
            None => all.into_iter().next_back(),
        }
    });
    match rec {
        Some(r) => {
            let truncated_flag = r.backtrace.chars().count() > 6000;
            let bt: String = r.backtrace.chars().take(6000).collect();
            let truncated = if truncated_flag {
                "\n…(обрезано; полный лог в папке логов)"
            } else {
                ""
            };
            let body = format!(
                "## Среда\nCuprum v{} · {}\n\n## Тип\n{}\n\n## Ошибка\n{}\n\n## Последняя операция\n{}\n\n## Где\n{}\n\n## Backtrace (пути обезличены)\n```\n{}{}\n```\n\n_Полный лог: {}_\n",
                r.version, r.os, r.kind, r.message, r.last_op, r.location, bt, truncated, log_dir
            );
            CrashReport {
                id: Some(r.id),
                title: format!("Сбой: {}", r.message.chars().take(80).collect::<String>()),
                body,
                log_dir,
            }
        }
        None => CrashReport {
            id: None,
            title: "Сообщение о проблеме".into(),
            body: format!(
                "## Среда\nCuprum v{} · {}\n\n## Описание\n<опишите проблему>\n",
                app.package_info().version,
                os_string()
            ),
            log_dir,
        },
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_home_dir() {
        let s = "at /Users/ivan/projects/board/foo.rs:10";
        assert_eq!(
            redact_paths(s, "/Users/ivan"),
            "at /Users/<user>/projects/board/foo.rs:10"
        );
    }

    #[test]
    fn keeps_relative_source_paths() {
        let s = "at cuprum-gerber/src/geometry.rs:42";
        assert_eq!(redact_paths(s, "/Users/ivan"), s);
    }

    #[test]
    fn empty_home_is_noop() {
        let s = "anything";
        assert_eq!(redact_paths(s, ""), s);
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    fn rec() -> CrashRecord {
        CrashRecord {
            id: 0,
            ts: "2026-06-16T00:00:00Z".into(),
            kind: "rust-panic".into(),
            version: "0.5.1".into(),
            os: "test".into(),
            message: "boom".into(),
            location: "x.rs:1".into(),
            backtrace: "bt".into(),
            last_op: "op".into(),
            reported: false,
            dismissed: false,
        }
    }

    #[test]
    fn write_then_read_back() {
        let dir = std::env::temp_dir().join(format!("cuprum-crash-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let id1 = write_record(&dir, rec()).unwrap();
        let id2 = write_record(&dir, rec()).unwrap();
        assert_eq!((id1, id2), (1, 2));
        assert_eq!(all_records(&dir).len(), 2);
        set_flags(&dir, id1, Some(true), None);
        assert!(
            all_records(&dir)
                .iter()
                .find(|r| r.id == 1)
                .unwrap()
                .reported
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
