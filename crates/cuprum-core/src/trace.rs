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
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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

pub(crate) fn run_with_config<T>(
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
}
