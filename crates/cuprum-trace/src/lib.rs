//! Local, opt-in tracing for profiling heavy pipeline phases.
//!
//! Enabled at runtime via the `CUPRUM_TRACE` env var (see `parse_config`). When
//! enabled, ONE process-global subscriber is installed (once) and a custom
//! `RoutingLayer` writes a separate Chrome Trace Event JSON file per `operation`,
//! keyed by an operation id. A global subscriber (rather than a per-operation
//! thread-scoped one) is required so spans created on shared rayon worker threads
//! are always recorded — a thread-scoped subscriber is silently bypassed on pool
//! workers under concurrency. See the design spec for the root-cause analysis.

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

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

/// Span field carrying the operation id on the root `operation` span. Filtered
/// out of the emitted `args` (internal routing key, not user data).
const OP_ID_FIELD: &str = "cuprum_op_id";

/// Per-operation Chrome-trace file writer. One thread track (`tid`) per OS thread
/// seen, assigned lazily; events are Chrome Trace Event objects in a JSON array.
struct OpSink {
    w: BufWriter<std::fs::File>,
    start: Instant,
    wrote_any: bool,
    tids: HashMap<ThreadId, usize>,
    next_tid: usize,
}

impl OpSink {
    fn new(path: &Path) -> std::io::Result<Self> {
        let mut w = BufWriter::new(std::fs::File::create(path)?);
        w.write_all(b"[\n")?;
        Ok(Self {
            w,
            start: Instant::now(),
            wrote_any: false,
            tids: HashMap::new(),
            next_tid: 0,
        })
    }

    fn write_entry(&mut self, val: &serde_json::Value) {
        if self.wrote_any {
            let _ = self.w.write_all(b",\n");
        }
        self.wrote_any = true;
        let _ = serde_json::to_writer(&mut self.w, val);
    }

    /// Resolve the current thread's per-file tid, emitting a `thread_name`
    /// metadata event the first time a thread is seen.
    fn tid(&mut self) -> usize {
        let id = std::thread::current().id();
        if let Some(&t) = self.tids.get(&id) {
            return t;
        }
        let t = self.next_tid;
        self.next_tid += 1;
        self.tids.insert(id, t);
        let name = std::thread::current()
            .name()
            .map(String::from)
            .unwrap_or_else(|| format!("thread-{t}"));
        let m = serde_json::json!({
            "name": "thread_name", "ph": "M", "pid": 1, "tid": t, "args": {"name": name}
        });
        self.write_entry(&m);
        t
    }

    /// Emit a Begin (`B`) or End (`E`) event for `meta` at the current instant.
    fn event(&mut self, ph: &str, meta: &SpanMeta) {
        let tid = self.tid();
        let ts = self.start.elapsed().as_nanos() as f64 / 1000.0; // microseconds
        let mut e = serde_json::json!({
            "name": meta.name, "cat": meta.target, "ph": ph, "pid": 1, "tid": tid, "ts": ts
        });
        if let Some(f) = &meta.file {
            e[".file"] = serde_json::Value::String(f.clone());
        }
        if let Some(l) = meta.line {
            e[".line"] = serde_json::Value::from(l);
        }
        if !meta.args.is_empty() {
            e["args"] = serde_json::Value::Object(meta.args.clone());
        }
        self.write_entry(&e);
    }

    fn finish(&mut self) {
        let _ = self.w.write_all(b"\n]\n");
        let _ = self.w.flush();
    }
}

/// Active per-operation sinks, keyed by operation id.
fn sinks() -> &'static Mutex<HashMap<u64, Arc<Mutex<OpSink>>>> {
    static S: OnceLock<Mutex<HashMap<u64, Arc<Mutex<OpSink>>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sink_for(op_id: u64) -> Option<Arc<Mutex<OpSink>>> {
    sinks().lock().unwrap().get(&op_id).cloned()
}

/// Reads the `cuprum_op_id` u64 field off a span's attributes (root op span).
struct OpIdVisitor(Option<u64>);
impl Visit for OpIdVisitor {
    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == OP_ID_FIELD {
            self.0 = Some(value);
        }
    }
    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
}

/// Collects span fields into Chrome `args` (Debug-formatted, matching
/// `tracing-chrome`'s `include_args`), skipping the internal routing key.
struct ArgsVisitor(serde_json::Map<String, serde_json::Value>);
impl Visit for ArgsVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == OP_ID_FIELD {
            return;
        }
        self.0.insert(
            field.name().to_string(),
            serde_json::Value::String(format!("{value:?}")),
        );
    }
}

/// Per-span data cached at creation for B/E emission + routing.
struct SpanMeta {
    op_id: u64,
    name: &'static str,
    target: String,
    file: Option<String>,
    line: Option<u32>,
    args: serde_json::Map<String, serde_json::Value>,
}

/// Global layer: routes each span's enter/exit to its operation's file.
struct RoutingLayer;

impl<S> Layer<S> for RoutingLayer
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        // op-id: this span's own field (root op span), else inherit from parent.
        let mut v = OpIdVisitor(None);
        attrs.record(&mut v);
        let op_id = v.0.or_else(|| {
            span.parent()
                .and_then(|p| p.extensions().get::<SpanMeta>().map(|m| m.op_id))
        });
        let Some(op_id) = op_id else {
            return; // span created outside any operation → ignored
        };
        let mut av = ArgsVisitor(serde_json::Map::new());
        attrs.record(&mut av);
        let meta = span.metadata();
        span.extensions_mut().insert(SpanMeta {
            op_id,
            name: meta.name(),
            target: meta.target().to_string(),
            file: meta.file().map(String::from),
            line: meta.line(),
            args: av.0,
        });
    }

    fn on_enter(&self, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let ext = span.extensions();
        let Some(meta) = ext.get::<SpanMeta>() else {
            return;
        };
        if let Some(sink) = sink_for(meta.op_id) {
            sink.lock().unwrap().event("B", meta);
        }
    }

    fn on_exit(&self, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let ext = span.extensions();
        let Some(meta) = ext.get::<SpanMeta>() else {
            return;
        };
        if let Some(sink) = sink_for(meta.op_id) {
            sink.lock().unwrap().event("E", meta);
        }
    }
}

/// Install the process-global subscriber exactly once (first enabled operation).
fn ensure_global_subscriber() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let filter = std::env::var("CUPRUM_TRACE_FILTER")
            .ok()
            .map(|s| {
                tracing_subscriber::EnvFilter::try_new(&s).unwrap_or_else(|e| {
                    eprintln!(
                        "cuprum: invalid CUPRUM_TRACE_FILTER {s:?}: {e}; capturing all spans"
                    );
                    tracing_subscriber::EnvFilter::new("trace")
                })
            })
            .unwrap_or_else(|| tracing_subscriber::EnvFilter::new("trace"));
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(RoutingLayer);
        if let Err(e) = tracing::subscriber::set_global_default(subscriber) {
            eprintln!("cuprum: could not install global trace subscriber: {e}");
        }
    });
}

/// Capture the current span so closures on rayon worker threads stay children of
/// the operation's root span (and thus route to its file). With a global
/// subscriber the dispatcher is already visible on every thread, so only the span
/// parentage needs propagating.
pub fn capture_dispatch() -> DispatchHandle {
    DispatchHandle {
        span: tracing::Span::current(),
    }
}

/// Handle to the captured parent span; re-enter it on any thread (e.g. a rayon
/// worker) so spans created inside become its children.
#[derive(Clone)]
pub struct DispatchHandle {
    span: tracing::Span,
}

impl DispatchHandle {
    /// Execute `f` with the captured span re-entered on the calling thread.
    pub fn run<R>(&self, f: impl FnOnce() -> R) -> R {
        self.span.in_scope(f)
    }
}

/// Run `f` as a traced operation. When tracing is disabled this is just `f()`.
/// When enabled, a per-operation Chrome-trace JSON file is written via the global
/// routing subscriber. All spans created during `f` — including on rayon workers
/// reached via [`capture_dispatch`]/[`DispatchHandle::run`] — land in this file.
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

    let result = {
        // The root span carries the op-id; RoutingLayer associates it and all its
        // children (incl. worker spans entered via `dh.run`) with this op's sink.
        let _root = tracing::info_span!("operation", op = name, cuprum_op_id = op_id).entered();
        f()
    };
    // Root span has exited here (guard dropped), so its E event is written.
    if let Some(sink) = sinks().lock().unwrap().remove(&op_id) {
        sink.lock().unwrap().finish();
    }

    let shown = file_path.canonicalize().unwrap_or(file_path);
    eprintln!("cuprum: trace → {}", shown.display());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
