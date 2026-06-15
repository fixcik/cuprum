pub(crate) mod board;
pub(crate) mod crash;
pub(crate) mod drill_run;
pub(crate) mod error;
pub(crate) mod expose_run;
pub(crate) mod fiducial;
pub(crate) mod machine;
pub(crate) mod mill_run;
pub(crate) mod operation_log;
pub(crate) mod panel;
pub(crate) mod printer;
pub(crate) mod project;
pub(crate) mod render;
pub(crate) mod windows;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use error::CmdResult;

/// App data dir, created if missing — the shared base for persisted catalogs and
/// caches (recents DB, kinematics). Centralizes the `app_data_dir` +
/// `create_dir_all` pair the command modules used to duplicate.
pub(crate) fn app_data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
