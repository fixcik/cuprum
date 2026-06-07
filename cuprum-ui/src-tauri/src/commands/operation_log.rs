//! Thin proxies over the operation-run journal in `cuprum-project` (catalog DB).
//! Op-agnostic: drill is the first writer; exposure / milling attach later with
//! their own `op_type`. The backend stamps `started_at`/`ended_at` so timestamps are
//! authoritative.

use serde::Serialize;
use tauri::AppHandle;

use crate::commands::project::{catalog_db_path, now_epoch};

/// One journalled run, sent to the History view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationRunDto {
    pub run_uid: String,
    pub project_path: String,
    pub op_type: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
    pub progress_total: Option<i64>,
    pub progress_done: i64,
    pub params_json: String,
    pub summary_json: Option<String>,
}

/// Record a just-launched run (backend stamps `started_at`).
#[tauri::command]
pub(crate) fn operation_run_log_start(
    app: AppHandle,
    run_uid: String,
    project_path: String,
    op_type: String,
    progress_total: Option<i64>,
    params_json: String,
) -> Result<(), String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::operation_run_start(
        &db,
        &run_uid,
        &project_path,
        &op_type,
        now_epoch(),
        progress_total,
        &params_json,
    )
    .map_err(|e| e.to_string())
}

/// Finalize a run (backend stamps `ended_at`).
#[tauri::command]
pub(crate) fn operation_run_log_finish(
    app: AppHandle,
    run_uid: String,
    outcome: String,
    progress_done: i64,
    summary_json: Option<String>,
) -> Result<(), String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::operation_run_finish(
        &db,
        &run_uid,
        now_epoch(),
        &outcome,
        progress_done,
        summary_json.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// List a project's runs (newest first), optionally filtered by `op_type`.
#[tauri::command]
pub(crate) fn operation_runs_list(
    app: AppHandle,
    project_path: String,
    op_type: Option<String>,
) -> Result<Vec<OperationRunDto>, String> {
    let db = catalog_db_path(&app)?;
    let runs = cuprum_project::operation_runs_list(&db, &project_path, op_type.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(runs
        .into_iter()
        .map(|r| OperationRunDto {
            run_uid: r.run_uid,
            project_path: r.project_path,
            op_type: r.op_type,
            started_at: r.started_at,
            ended_at: r.ended_at,
            outcome: r.outcome,
            progress_total: r.progress_total,
            progress_done: r.progress_done,
            params_json: r.params_json,
            summary_json: r.summary_json,
        })
        .collect())
}

/// The most recent run's `params_json` for prefill (`None` if no prior run).
#[tauri::command]
pub(crate) fn operation_run_last_params(
    app: AppHandle,
    project_path: String,
    op_type: String,
) -> Result<Option<String>, String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::operation_run_last_params(&db, &project_path, &op_type)
        .map_err(|e| e.to_string())
}
