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

/// Capture the current thread's tracing `Dispatch` and active `Span` so that
/// closures executed on rayon worker threads still land in the same trace file.
///
/// `trace::operation` installs a thread-local subscriber; rayon worker threads
/// do not inherit it. Call `capture_dispatch()` on the OUTER thread (inside the
/// `operation` closure, before spawning rayon work), then call
/// `handle.run(f)` inside each worker closure so the spans are recorded in the
/// single operation file as per-thread tracks.
///
/// No-op overhead when tracing is disabled (the default dispatch is a no-op
/// subscriber).
pub fn capture_dispatch() -> DispatchHandle {
    DispatchHandle {
        dispatch: tracing::dispatcher::get_default(|d| d.clone()),
        span: tracing::Span::current(),
    }
}

/// An opaque handle holding a captured `Dispatch` + parent `Span`. Obtained via
/// [`capture_dispatch`]; cheaply cloneable (the inner `Arc`s are shared).
/// Call [`run`](DispatchHandle::run) on any thread to execute a closure with
/// the captured subscriber restored.
#[derive(Clone)]
pub struct DispatchHandle {
    dispatch: tracing::Dispatch,
    span: tracing::Span,
}

impl DispatchHandle {
    /// Execute `f` with the captured subscriber and span re-established on the
    /// calling thread (which may be a rayon worker).
    pub fn run<R>(&self, f: impl FnOnce() -> R) -> R {
        tracing::dispatcher::with_default(&self.dispatch, || self.span.in_scope(f))
    }
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
        .map(|s| {
            tracing_subscriber::EnvFilter::try_new(&s).unwrap_or_else(|e| {
                eprintln!("cuprum: invalid CUPRUM_TRACE_FILTER {s:?}: {e}; capturing all spans");
                tracing_subscriber::EnvFilter::new("trace")
            })
        })
        .unwrap_or_else(|| tracing_subscriber::EnvFilter::new("trace"));
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(chrome_layer);

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
    fn operation_twice_on_same_thread_both_write() {
        // Tokio's spawn_blocking reuses OS threads, so `operation` can run more
        // than once on the same thread. Each call must restore the thread-local
        // subscriber cleanly and produce its own valid trace file.
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-twice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        for i in 0..2 {
            let r = run_with_config(&cfg, "twice_op", &tmp, || {
                let _s = tracing::info_span!("inner").entered();
                i
            });
            assert_eq!(r, i);
        }

        let files: Vec<_> = std::fs::read_dir(&tmp)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        assert_eq!(files.len(), 2, "each call writes its own trace file");
        for f in &files {
            let body = std::fs::read_to_string(f).unwrap();
            serde_json::from_str::<serde_json::Value>(&body).expect("trace is valid JSON");
            assert!(body.contains("inner"), "span present in {f:?}");
        }

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

    #[test]
    fn parallel_spans_land_in_single_trace_via_dispatch() {
        use rayon::prelude::*;
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-par-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        run_with_config(&cfg, "batch_op", &tmp, || {
            // Capture dispatch + current span on the OUTER thread (inside the
            // `operation` scope where the subscriber is installed), then hand
            // the handle to rayon workers so their spans land in this file.
            let handle = super::capture_dispatch();
            (0..4).into_par_iter().for_each(|i| {
                handle.run(|| {
                    let _s = tracing::info_span!("worker_layer", i = i as u64).entered();
                });
            });
        });

        let files: Vec<_> = std::fs::read_dir(&tmp)
            .expect("trace dir")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        assert_eq!(files.len(), 1, "exactly one trace file for the whole batch");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON");
        assert!(body.contains("batch_op"), "root op present");
        assert!(
            body.contains("worker_layer"),
            "worker-thread spans captured in the single file"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn spin() {
        let mut x = 0u64;
        for i in 0..1_500_000u64 {
            x = x.wrapping_add(i ^ (x >> 3));
        }
        std::hint::black_box(x);
    }

    fn span_names(dir: &std::path::Path) -> std::collections::BTreeSet<String> {
        let file = std::fs::read_dir(dir)
            .expect("trace dir")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .expect("a json trace file");
        let body = std::fs::read_to_string(&file).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON trace");
        v.as_array()
            .unwrap()
            .iter()
            .filter(|e| e.get("ph").and_then(|p| p.as_str()) == Some("B"))
            .filter_map(|e| e.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect()
    }

    #[test]
    fn concurrent_operations_keep_worker_spans() {
        use rayon::prelude::*;
        use std::sync::{Arc, Barrier};
        let base = std::env::temp_dir().join(format!("cuprum-trace-conc-{}", std::process::id()));
        let a = base.join("a");
        let b = base.join("b");
        let barrier = Arc::new(Barrier::new(2));
        // Several rounds to hit the interleaving window reliably.
        for _round in 0..15 {
            let _ = std::fs::remove_dir_all(&a);
            let _ = std::fs::remove_dir_all(&b);
            let (ba, bb) = (barrier.clone(), barrier.clone());
            let (ca, cb) = (a.clone(), b.clone());
            let ha = std::thread::spawn(move || {
                ba.wait();
                run_with_config(&TraceConfig::Dir(ca.clone()), "metrics_like", &ca, || {
                    let dh = super::capture_dispatch();
                    rayon::join(
                        || {
                            dh.run(|| {
                                let dh2 = super::capture_dispatch();
                                (0..6).into_par_iter().for_each(|_| {
                                    dh2.run(|| {
                                        let dh3 = super::capture_dispatch();
                                        (0..6).into_par_iter().for_each(|_| {
                                            dh3.run(|| {
                                                let _s = tracing::info_span!("m_sweep").entered();
                                                spin();
                                            });
                                        });
                                    });
                                });
                            })
                        },
                        || dh.run(|| {
                            let _s = tracing::info_span!("m_zone3").entered();
                            spin();
                        }),
                    );
                });
            });
            let hb = std::thread::spawn(move || {
                bb.wait();
                run_with_config(&TraceConfig::Dir(cb.clone()), "svg_like", &cb, || {
                    let dh = super::capture_dispatch();
                    (0..12).into_par_iter().for_each(|_| {
                        dh.run(|| {
                            let _s = tracing::info_span!("svg_layer").entered();
                            spin();
                        });
                    });
                });
            });
            ha.join().unwrap();
            hb.join().unwrap();
            let na = span_names(&a);
            let nb = span_names(&b);
            assert!(na.contains("m_sweep"), "round {_round}: metrics lost worker spans: {na:?}");
            assert!(nb.contains("svg_layer"), "round {_round}: svg lost worker spans: {nb:?}");
            // Routing isolation: no cross-file leakage.
            assert!(!nb.contains("m_sweep"), "round {_round}: metrics span leaked into svg file: {nb:?}");
            assert!(!na.contains("svg_layer"), "round {_round}: svg span leaked into metrics file: {na:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
