//! The operation/session trace API and the background idle-reaper.
//!
//! `operation` writes a standalone per-op file; `begin_session` +
//! `operation_in_session` share one file across several ops; `run_with_config` is
//! the underlying standalone runner. Sessions are finalized by an idle-reaper
//! thread (or `finalize_session_now` in tests). Builds on [`crate::sink`] (the
//! file writer + registry) and [`crate::layer`] (the global subscriber).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::{config, TraceConfig};
use crate::layer::ensure_global_subscriber;
use crate::sink::{sinks, OpSink};

/// Monotonic per-process counter so two operations in the same millisecond
/// don't collide on a filename.
fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Monotonic operation id; routes a span's events to the right per-op file.
fn next_op_id() -> u64 {
    static OP: AtomicU64 = AtomicU64::new(1);
    OP.fetch_add(1, Ordering::Relaxed)
}

fn millis_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Run `f` as a traced operation. When tracing is disabled this is just `f()`.
/// When enabled, a per-operation Chrome-trace JSON file is written via the global
/// routing subscriber. All spans created during `f` — including on rayon workers
/// reached via `capture_dispatch`/`DispatchHandle::run` — land in this file.
pub fn operation<T>(name: &str, default_dir: &Path, f: impl FnOnce() -> T) -> T {
    run_with_config(config(), name, default_dir, f)
}

// ── Session registry ──────────────────────────────────────────────────────────

/// Per-session state owned by the session registry.
struct SessionState {
    sink: Arc<Mutex<OpSink>>,
    file_path: PathBuf,
    /// Number of in-flight `operation_in_session` calls using this session.
    open_ops: usize,
    /// Updated at session open and after each operation completes.
    last_activity: Instant,
}

/// Active sessions, keyed by session id.
fn sessions() -> &'static Mutex<HashMap<u64, SessionState>> {
    static S: OnceLock<Mutex<HashMap<u64, SessionState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Monotonic session id counter starting at 1.
fn next_session_id() -> u64 {
    static SID: AtomicU64 = AtomicU64::new(1);
    SID.fetch_add(1, Ordering::Relaxed)
}

// ── Idle reaper ───────────────────────────────────────────────────────────────

/// Idle timeout from `CUPRUM_TRACE_SESSION_IDLE_MS` (default 1 500 ms), read
/// once from the env (a bad/unparseable value falls back to the default).
fn idle_timeout() -> Duration {
    static IDLE: OnceLock<Duration> = OnceLock::new();
    *IDLE.get_or_init(|| {
        std::env::var("CUPRUM_TRACE_SESSION_IDLE_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_millis(1500))
    })
}

/// Synchronously finalize a session by removing it from the registry and
/// flushing its sink. Used by the reaper and, in tests, for determinism.
///
/// SKIPS (no-op) if an operation is in flight on the session (`open_ops > 0`):
/// the "is idle?" check and the removal are done together under the `sessions()`
/// lock, so a late-joining op can never have its events appended to an
/// already-closed (`]`) file. The reaper retries on its next cycle.
pub(crate) fn finalize_session_now(sid: u64) {
    let state = {
        let mut map = sessions().lock().unwrap();
        // Guard the TOCTOU window: if an op joined between the reaper's idle scan
        // and now, skip finalizing. Makes "is idle?" and "remove" atomic.
        if map.get(&sid).is_some_and(|s| s.open_ops > 0) {
            return;
        }
        map.remove(&sid)
    };
    if let Some(state) = state {
        state.sink.lock().unwrap().finish();
        let shown = state
            .file_path
            .canonicalize()
            .unwrap_or(state.file_path.clone());
        eprintln!("cuprum: trace → {}", shown.display());
    }
}

/// Finalize all sessions with `open_ops == 0` whose last activity exceeds
/// `timeout`. Collects idle session ids while holding the lock, then finalizes
/// each one (which re-locks briefly) outside the initial lock scope.
fn reap_idle_with_timeout(timeout: Duration) {
    let idle_sids: Vec<u64> = {
        let map = sessions().lock().unwrap();
        map.iter()
            .filter(|(_, s)| s.open_ops == 0 && s.last_activity.elapsed() > timeout)
            .map(|(k, _)| *k)
            .collect()
    };
    for sid in idle_sids {
        finalize_session_now(sid);
    }
}

/// Reap using the env-configured idle timeout.
fn reap_idle() {
    reap_idle_with_timeout(idle_timeout());
}

/// Spawn the idle-reaper background thread exactly once (lazy).
fn ensure_reaper() {
    static REAPER: OnceLock<()> = OnceLock::new();
    REAPER.get_or_init(|| {
        if let Err(e) = std::thread::Builder::new()
            .name("cuprum-trace-reaper".to_string())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_millis(250));
                reap_idle();
            })
        {
            eprintln!("cuprum: trace reaper spawn failed: {e}");
        }
    });
}

// ── Public session API ────────────────────────────────────────────────────────

/// Open a trace session. Subsequent `operation_in_session` calls with the
/// returned id write into ONE shared file with a shared time origin. Returns
/// `None` when tracing is disabled. Finalized by the idle reaper or
/// `finalize_session_now` in tests.
pub fn begin_session(name: &str, default_dir: &Path) -> Option<u64> {
    begin_session_with_config(config(), name, default_dir)
}

fn begin_session_with_config(cfg: &TraceConfig, name: &str, default_dir: &Path) -> Option<u64> {
    let dir = match cfg {
        TraceConfig::Off => return None,
        TraceConfig::DefaultDir => default_dir.to_path_buf(),
        TraceConfig::Dir(d) => d.clone(),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "cuprum: trace dir {} unusable: {e}; tracing skipped",
            dir.display()
        );
        return None;
    }
    ensure_global_subscriber();

    let sid = next_session_id();
    let file_path = dir.join(format!("{name}_{:04}_{}.json", next_seq(), millis_stamp()));
    let sink = match OpSink::new(&file_path) {
        Ok(s) => Arc::new(Mutex::new(s)),
        Err(e) => {
            eprintln!(
                "cuprum: cannot open session trace file {}: {e}",
                file_path.display()
            );
            return None;
        }
    };
    sessions().lock().unwrap().insert(
        sid,
        SessionState {
            sink,
            file_path,
            open_ops: 0,
            last_activity: Instant::now(),
        },
    );
    ensure_reaper();
    Some(sid)
}

/// Run `f` as a traced operation within a session.
///
/// If `session_id` is `None` or tracing is disabled, delegates to
/// [`operation`] (standalone file). If the session has already been finalized,
/// also falls back to a standalone file. Must not panic.
pub fn operation_in_session<T>(
    session_id: Option<u64>,
    name: &str,
    default_dir: &Path,
    f: impl FnOnce() -> T,
) -> T {
    operation_in_session_with_config(config(), session_id, name, default_dir, f)
}

fn operation_in_session_with_config<T>(
    cfg: &TraceConfig,
    session_id: Option<u64>,
    name: &str,
    default_dir: &Path,
    f: impl FnOnce() -> T,
) -> T {
    // Fall back to standalone when disabled or no session id.
    let sid = match session_id {
        Some(s) if !matches!(cfg, TraceConfig::Off) => s,
        _ => return run_with_config(cfg, name, default_dir, f),
    };

    // Look up the session's shared sink.  If gone, fall back.
    let sink_arc: Arc<Mutex<OpSink>> = {
        let mut map = sessions().lock().unwrap();
        match map.get_mut(&sid) {
            Some(state) => {
                state.open_ops += 1;
                state.last_activity = Instant::now();
                state.sink.clone()
            }
            None => return run_with_config(cfg, name, default_dir, f),
        }
    };

    let op_id = next_op_id();
    sinks().lock().unwrap().insert(op_id, sink_arc);

    // RAII guard so the routing + bookkeeping cleanup runs on both normal return
    // AND on unwind if `f` panics. Without it, a panic would leave `open_ops > 0`
    // forever: the reaper would never finalize the session and its file would stay
    // open. Constructed AFTER incrementing `open_ops` / inserting into `sinks()`.
    struct OpGuard {
        op_id: u64,
        sid: u64,
    }
    impl Drop for OpGuard {
        fn drop(&mut self) {
            // Order matters: remove the op from the routing table FIRST, then
            // decrement `open_ops` LAST. This ensures the reaper can't observe
            // `open_ops == 0` (and finalize the sink) while this op's events are
            // still being routed to it.
            sinks().lock().unwrap().remove(&self.op_id);
            if let Some(state) = sessions().lock().unwrap().get_mut(&self.sid) {
                state.open_ops = state.open_ops.saturating_sub(1);
                state.last_activity = Instant::now();
            }
        }
    }
    let _guard = OpGuard { op_id, sid };

    // The root span exits when this scope's guard drops; its E event is written
    // before `_guard` (declared earlier) removes the op from routing.
    let _root = tracing::info_span!("operation", op = name, cuprum_op_id = op_id).entered();
    f()
}

pub fn run_with_config<T>(
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
    ensure_global_subscriber();

    let op_id = next_op_id();
    let file_path = dir.join(format!("{name}_{:04}_{}.json", next_seq(), millis_stamp()));
    let sink = match OpSink::new(&file_path) {
        Ok(s) => Arc::new(Mutex::new(s)),
        Err(e) => {
            eprintln!(
                "cuprum: cannot open trace file {}: {e}",
                file_path.display()
            );
            return f();
        }
    };
    sinks().lock().unwrap().insert(op_id, sink);

    // RAII guard so the routing entry is removed and the file is closed (valid
    // JSON) on BOTH normal return and unwind — a panic in `f` previously left
    // the trace file unterminated and leaked the sink entry forever. Declared
    // BEFORE the root span guard: locals drop in reverse order, so the span's
    // E event is written before the file is finished.
    struct FinishGuard {
        op_id: u64,
        file_path: PathBuf,
    }
    impl Drop for FinishGuard {
        fn drop(&mut self) {
            // `unwrap_or_else(into_inner)` instead of `unwrap`: this Drop can run
            // during a panic-unwind, and panicking again on a poisoned lock would
            // abort the process.
            let sink = sinks()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.op_id);
            if let Some(sink) = sink {
                sink.lock().unwrap_or_else(|e| e.into_inner()).finish();
            }
            let shown = self
                .file_path
                .canonicalize()
                .unwrap_or_else(|_| self.file_path.clone());
            eprintln!("cuprum: trace → {}", shown.display());
        }
    }
    let _guard = FinishGuard { op_id, file_path };

    // The root span carries the op-id; RoutingLayer associates it and all its
    // children (incl. worker spans entered via `dh.run`) with this op's sink.
    // Its guard drops (E event written) before `_guard` closes the file.
    let _root = tracing::info_span!("operation", op = name, cuprum_op_id = op_id).entered();
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_dispatch;
    use std::path::PathBuf;

    // These tests share a PROCESS-GLOBAL subscriber and global session/sink maps;
    // `reap_idle_with_timeout(ZERO)` even finalizes EVERY idle session, so two
    // runtime-touching tests running concurrently corrupt each other's files. Hold
    // this lock for the duration of any such test to run them one at a time.
    // (`into_inner` so a panicking/failing test doesn't poison the rest.)
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn operation_writes_named_trace_file() {
        let _serial = serial();
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
        let _serial = serial();
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
        let _serial = serial();
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-off-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let result = run_with_config(&TraceConfig::Off, "unit_op", &tmp, || 7);
        assert_eq!(result, 7);
        assert!(!tmp.exists(), "no trace dir created when disabled");
    }

    #[test]
    fn parallel_spans_land_in_single_trace_via_dispatch() {
        let _serial = serial();
        use rayon::prelude::*;
        let tmp = std::env::temp_dir().join(format!("cuprum-trace-par-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        run_with_config(&cfg, "batch_op", &tmp, || {
            // Capture dispatch + current span on the OUTER thread (inside the
            // `operation` scope where the subscriber is installed), then hand
            // the handle to rayon workers so their spans land in this file.
            let handle = capture_dispatch();
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
        let _serial = serial();
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
                    let dh = capture_dispatch();
                    rayon::join(
                        || {
                            dh.run(|| {
                                let dh2 = capture_dispatch();
                                (0..6).into_par_iter().for_each(|_| {
                                    dh2.run(|| {
                                        let dh3 = capture_dispatch();
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
                        || {
                            dh.run(|| {
                                let _s = tracing::info_span!("m_zone3").entered();
                                spin();
                            })
                        },
                    );
                });
            });
            let hb = std::thread::spawn(move || {
                bb.wait();
                run_with_config(&TraceConfig::Dir(cb.clone()), "svg_like", &cb, || {
                    let dh = capture_dispatch();
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
            assert!(
                na.contains("m_sweep"),
                "round {_round}: metrics lost worker spans: {na:?}"
            );
            assert!(
                nb.contains("svg_layer"),
                "round {_round}: svg lost worker spans: {nb:?}"
            );
            // Routing isolation: no cross-file leakage.
            assert!(
                !nb.contains("m_sweep"),
                "round {_round}: metrics span leaked into svg file: {nb:?}"
            );
            assert!(
                !na.contains("svg_layer"),
                "round {_round}: svg span leaked into metrics file: {na:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn span_outside_any_operation_is_ignored() {
        // With the global subscriber possibly installed by other tests, a span
        // created with no active operation must route nowhere (op-id None) — no
        // panic, no file. We only assert it does not panic and yields no events
        // attributable to an operation.
        let _s = tracing::info_span!("orphan_span").entered();
        // Nothing to flush, nothing to assert beyond "did not panic / no sink".
        // (Sinks map is only populated inside `run_with_config`.)
    }

    // ── Session tests ─────────────────────────────────────────────────────────

    /// Collect all JSON files in `dir`.
    fn json_files(dir: &std::path::Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect()
    }

    #[test]
    fn session_groups_operations_into_one_file() {
        let _serial = serial();
        let tmp =
            std::env::temp_dir().join(format!("cuprum-trace-session-group-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid =
            begin_session_with_config(&cfg, "sess", &tmp).expect("session created with Dir config");

        operation_in_session_with_config(&cfg, Some(sid), "op_a", &tmp, || {
            let _s = tracing::info_span!("step_a").entered();
        });
        operation_in_session_with_config(&cfg, Some(sid), "op_b", &tmp, || {
            let _s = tracing::info_span!("step_b").entered();
        });

        finalize_session_now(sid);

        let files = json_files(&tmp);
        assert_eq!(
            files.len(),
            1,
            "exactly one session file expected, got {files:?}"
        );

        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("session file is valid JSON");
        assert!(body.contains("op_a"), "op_a must be in the session file");
        assert!(body.contains("op_b"), "op_b must be in the session file");
        assert!(
            body.contains("operation"),
            "root operation spans must be present"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn operation_in_session_none_is_passthrough() {
        let _serial = serial();
        let tmp = std::env::temp_dir().join(format!(
            "cuprum-trace-session-passthrough-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        // session_id = None → standalone operation
        operation_in_session_with_config(&cfg, None, "solo", &tmp, || {
            let _s = tracing::info_span!("solo_inner").entered();
        });

        let files = json_files(&tmp);
        assert!(
            !files.is_empty(),
            "a trace file must be written for the passthrough op"
        );
        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON");
        assert!(body.contains("solo"), "standalone op name present");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn expired_session_falls_back_to_standalone() {
        let _serial = serial();
        let tmp = std::env::temp_dir().join(format!(
            "cuprum-trace-session-expired-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid = begin_session_with_config(&cfg, "exp", &tmp).expect("session created");

        // Finalize before the operation uses it.
        finalize_session_now(sid);

        // Must not panic; should fall back to a standalone file.
        operation_in_session_with_config(&cfg, Some(sid), "after", &tmp, || {
            let _s = tracing::info_span!("after_inner").entered();
        });

        let files = json_files(&tmp);
        // One file: the session file (empty / finalized) + standalone for "after".
        // Actually the session file was opened but closed immediately; standalone
        // also produces a file. We have at least one file containing "after".
        let has_after = files.iter().any(|f| {
            std::fs::read_to_string(f)
                .map(|b| b.contains("after"))
                .unwrap_or(false)
        });
        assert!(has_after, "standalone fallback file must contain 'after'");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reaper_finalizes_idle_session() {
        let _serial = serial();
        let tmp =
            std::env::temp_dir().join(format!("cuprum-trace-session-reap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid = begin_session_with_config(&cfg, "idle", &tmp).expect("session created");

        // Reap with zero timeout: any session with no in-flight op counts as idle.
        reap_idle_with_timeout(Duration::ZERO);

        // Session must be gone from registry.
        assert!(
            sessions().lock().unwrap().get(&sid).is_none(),
            "session must be removed after reaping"
        );

        // File must be a valid, closed JSON array.
        let files = json_files(&tmp);
        assert_eq!(files.len(), 1, "reaper must have produced one file");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        let trimmed = body.trim();
        assert!(
            trimmed.ends_with(']'),
            "trace file must be closed with ']' after reap, got: {trimmed:?}"
        );
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON after reap");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn session_keeps_worker_spans_across_two_ops() {
        let _serial = serial();
        use rayon::prelude::*;
        let tmp = std::env::temp_dir().join(format!(
            "cuprum-trace-session-workers-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid = begin_session_with_config(&cfg, "sess_par", &tmp).expect("session created");

        for op_name in &["par_op_1", "par_op_2"] {
            operation_in_session_with_config(&cfg, Some(sid), op_name, &tmp, || {
                let dh = capture_dispatch();
                (0..4).into_par_iter().for_each(|i| {
                    dh.run(|| {
                        let _s = tracing::info_span!("sess_worker", i = i as u64).entered();
                    });
                });
            });
        }

        finalize_session_now(sid);

        let files = json_files(&tmp);
        assert_eq!(files.len(), 1, "all ops must share one session file");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON");
        assert!(
            body.contains("sess_worker"),
            "worker spans from session ops must appear in the session file"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn panic_in_op_runs_cleanup_guard() {
        let _serial = serial();
        // If `f` panics, the RAII guard must still remove the op from routing and
        // decrement `open_ops`, so the session stays reapable and its file closes.
        let tmp =
            std::env::temp_dir().join(format!("cuprum-trace-session-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid = begin_session_with_config(&cfg, "panicky", &tmp).expect("session created");

        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            operation_in_session_with_config(&cfg, Some(sid), "boom", &tmp, || {
                let _s = tracing::info_span!("boom_inner").entered();
                panic!("intentional");
            });
        }));
        assert!(caught.is_err(), "panic must propagate out of the op");

        // Guard must have decremented open_ops back to 0 on unwind.
        {
            let map = sessions().lock().unwrap();
            let state = map.get(&sid).expect("session still registered after panic");
            assert_eq!(state.open_ops, 0, "open_ops must return to 0 on unwind");
        }

        // Reaper can therefore finalize it; file must be a valid closed array.
        reap_idle_with_timeout(Duration::ZERO);
        assert!(
            sessions().lock().unwrap().get(&sid).is_none(),
            "panicked session must be reapable"
        );
        let files = json_files(&tmp);
        assert_eq!(files.len(), 1, "one session file written");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON after panic + reap");
        assert!(body.trim().ends_with(']'), "file closed after reap");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn panic_in_standalone_op_closes_file_and_cleans_routing() {
        let _serial = serial();
        // A panic inside a standalone `run_with_config` op must still close the
        // trace file (valid JSON) and remove the op from the routing table —
        // otherwise the file stays unterminated and the sink entry leaks forever.
        let tmp = std::env::temp_dir().join(format!(
            "cuprum-trace-standalone-panic-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sinks_before = sinks().lock().unwrap().len();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_with_config(&cfg, "boom_standalone", &tmp, || {
                let _s = tracing::info_span!("boom_inner").entered();
                panic!("intentional");
            });
        }));
        assert!(caught.is_err(), "panic must propagate out of the op");

        assert_eq!(
            sinks().lock().unwrap().len(),
            sinks_before,
            "panicked op must not leak a routing-table entry"
        );

        let files = json_files(&tmp);
        assert_eq!(files.len(), 1, "one trace file written");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body)
            .expect("trace file must be valid (closed) JSON after a panic");
        assert!(body.contains("boom_standalone"), "root op name present");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn finalize_session_now_skips_when_op_in_flight() {
        let _serial = serial();
        // Regression for the TOCTOU window between the reaper's idle scan and
        // finalize: an op that joined the session (open_ops > 0) must keep the
        // session alive — finalize must skip, not close the shared file.
        let tmp = std::env::temp_dir().join(format!(
            "cuprum-trace-session-toctou-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = TraceConfig::Dir(tmp.clone());

        let sid = begin_session_with_config(&cfg, "toctou", &tmp).expect("session created");

        // Simulate a late joiner: an op is now in flight on this session.
        {
            let mut map = sessions().lock().unwrap();
            map.get_mut(&sid).expect("session present").open_ops = 1;
        }

        // Finalize must be a no-op while an op is in flight.
        finalize_session_now(sid);
        assert!(
            sessions().lock().unwrap().get(&sid).is_some(),
            "session must survive finalize while open_ops > 0"
        );
        let body = std::fs::read_to_string(&json_files(&tmp)[0]).unwrap();
        assert!(
            !body.trim().ends_with(']'),
            "file must not be closed while an op is in flight"
        );

        // Op finished → now finalize succeeds.
        {
            let mut map = sessions().lock().unwrap();
            map.get_mut(&sid).expect("session present").open_ops = 0;
        }
        finalize_session_now(sid);
        assert!(
            sessions().lock().unwrap().get(&sid).is_none(),
            "session must finalize once open_ops returns to 0"
        );
        let body = std::fs::read_to_string(&json_files(&tmp)[0]).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("valid JSON after finalize");
        assert!(body.trim().ends_with(']'), "file closed after finalize");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
