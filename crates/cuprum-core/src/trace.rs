//! Local, opt-in tracing for profiling heavy pipeline phases.
//!
//! Enabled at runtime via the `CUPRUM_TRACE` env var (see `parse_config`). When
//! disabled, `operation` runs its closure with no subscriber and near-zero cost.
//! When enabled, each call to `operation` writes one Chrome Trace Event JSON file
//! (openable in <https://ui.perfetto.dev>) for that operation.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_subscriber::prelude::*;

/// Where (and whether) traces should be written, decided once from the env.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceConfig {
    /// Tracing disabled (`CUPRUM_TRACE` unset, empty, `0`, `off`, `false`).
    Off,
    /// Enabled; write to the caller-provided default directory.
    DefaultDir,
    /// Enabled; write to this explicit directory.
    Dir(PathBuf),
}

/// Parse a `CUPRUM_TRACE` value into a config. Pure and testable.
pub fn parse_config(value: Option<&str>) -> TraceConfig {
    match value.map(str::trim) {
        None | Some("") | Some("0") | Some("off") | Some("false") => TraceConfig::Off,
        Some("1") | Some("on") | Some("true") => TraceConfig::DefaultDir,
        Some(path) => TraceConfig::Dir(PathBuf::from(path)),
    }
}

/// Process-wide config, read once from `CUPRUM_TRACE`.
fn config() -> &'static TraceConfig {
    static CFG: OnceLock<TraceConfig> = OnceLock::new();
    CFG.get_or_init(|| parse_config(std::env::var("CUPRUM_TRACE").ok().as_deref()))
}

/// Whether tracing is enabled this run.
pub fn is_enabled() -> bool {
    !matches!(config(), TraceConfig::Off)
}

/// Monotonic per-process counter so two operations in the same millisecond
/// don't collide on a filename.
fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn millis_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Run `f` as a traced operation. When tracing is disabled this is just `f()`.
/// When enabled, a thread-scoped subscriber writes one Chrome-trace JSON file for
/// this operation to the configured directory (or `default_dir`).
///
/// All spans created on the calling thread during `f` (including those in `core`
/// functions it invokes synchronously) land in this operation's file.
pub fn operation<T>(name: &str, default_dir: &Path, f: impl FnOnce() -> T) -> T {
    run_with_config(config(), name, default_dir, f)
}

fn run_with_config<T>(
    cfg: &TraceConfig,
    name: &str,
    default_dir: &Path,
    f: impl FnOnce() -> T,
) -> T {
    let dir = match cfg {
        TraceConfig::Off => return f(),
        TraceConfig::DefaultDir => default_dir.to_path_buf(),
        TraceConfig::Dir(d) => d.clone(),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "cuprum: trace dir {} unusable: {e}; tracing skipped",
            dir.display()
        );
        return f();
    }
    let file_path = dir.join(format!("{name}_{:04}_{}.json", next_seq(), millis_stamp()));

    // ChromeLayerBuilder returns a flush guard that finalizes the file on drop.
    let (chrome_layer, guard) = tracing_chrome::ChromeLayerBuilder::new()
        .file(&file_path)
        .include_args(true)
        .build();
    let filter = std::env::var("CUPRUM_TRACE_FILTER")
        .ok()
        .and_then(|s| tracing_subscriber::EnvFilter::try_new(s).ok())
        .unwrap_or_else(|| tracing_subscriber::EnvFilter::new("trace"));
    let subscriber = tracing_subscriber::registry().with(filter).with(chrome_layer);

    let result = tracing::subscriber::with_default(subscriber, || {
        let _root = tracing::info_span!("operation", op = name).entered();
        f()
    });
    drop(guard); // flush the JSON file before we log its path

    let shown = file_path.canonicalize().unwrap_or(file_path);
    eprintln!("cuprum: trace → {}", shown.display());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_config_maps_values() {
        assert_eq!(parse_config(None), TraceConfig::Off);
        assert_eq!(parse_config(Some("")), TraceConfig::Off);
        assert_eq!(parse_config(Some("0")), TraceConfig::Off);
        assert_eq!(parse_config(Some("off")), TraceConfig::Off);
        assert_eq!(parse_config(Some("1")), TraceConfig::DefaultDir);
        assert_eq!(parse_config(Some("on")), TraceConfig::DefaultDir);
        assert_eq!(parse_config(Some("true")), TraceConfig::DefaultDir);
        assert_eq!(
            parse_config(Some("/tmp/traces")),
            TraceConfig::Dir(PathBuf::from("/tmp/traces"))
        );
        // Surrounding whitespace is trimmed.
        assert_eq!(parse_config(Some("  1  ")), TraceConfig::DefaultDir);
    }

    #[test]
    fn operation_writes_named_trace_file() {
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let result = run_with_config(&cfg, "unit_op", &tmp, || {
            let _s = tracing::info_span!("inner_step").entered();
            21 * 2
        });
        assert_eq!(result, 42, "closure result must be returned");

        let files: Vec<_> = std::fs::read_dir(&tmp)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        assert_eq!(files.len(), 1, "exactly one trace file written");

        let body = std::fs::read_to_string(&files[0]).unwrap();
        // Valid JSON and contains our span names.
        serde_json::from_str::<serde_json::Value>(&body).expect("trace is valid JSON");
        assert!(body.contains("unit_op"), "root op name present");
        assert!(body.contains("inner_step"), "inner span present");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn operation_disabled_writes_nothing() {
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-off-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let result = run_with_config(&TraceConfig::Off, "unit_op", &tmp, || 7);
        assert_eq!(result, 7);
        assert!(!tmp.exists(), "no trace dir created when disabled");
    }
}
