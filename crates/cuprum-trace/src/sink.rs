//! The per-operation Chrome-trace file writer ([`OpSink`]), the active-sink
//! registry keyed by operation id, and the span-field visitors that feed it.

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::Instant;

use tracing::field::{Field, Visit};

/// Span field carrying the operation id on the root `operation` span. Filtered
/// out of the emitted `args` (internal routing key, not user data).
const OP_ID_FIELD: &str = "cuprum_op_id";

/// Per-operation Chrome-trace file writer. One thread track (`tid`) per OS thread
/// seen, assigned lazily; events are Chrome Trace Event objects in a JSON array.
pub(crate) struct OpSink {
    w: BufWriter<std::fs::File>,
    start: Instant,
    wrote_any: bool,
    tids: HashMap<ThreadId, usize>,
    next_tid: usize,
}

impl OpSink {
    pub(crate) fn new(path: &Path) -> std::io::Result<Self> {
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
    pub(crate) fn event(&mut self, ph: &str, meta: &SpanMeta) {
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

    pub(crate) fn finish(&mut self) {
        let _ = self.w.write_all(b"\n]\n");
        let _ = self.w.flush();
    }
}

/// Active per-operation sinks, keyed by operation id.
pub(crate) fn sinks() -> &'static Mutex<HashMap<u64, Arc<Mutex<OpSink>>>> {
    static S: OnceLock<Mutex<HashMap<u64, Arc<Mutex<OpSink>>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn sink_for(op_id: u64) -> Option<Arc<Mutex<OpSink>>> {
    sinks().lock().unwrap().get(&op_id).cloned()
}

/// Reads the `cuprum_op_id` u64 field off a span's attributes (root op span).
pub(crate) struct OpIdVisitor(pub(crate) Option<u64>);
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
pub(crate) struct ArgsVisitor(pub(crate) serde_json::Map<String, serde_json::Value>);
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
pub(crate) struct SpanMeta {
    pub(crate) op_id: u64,
    pub(crate) name: &'static str,
    pub(crate) target: String,
    pub(crate) file: Option<String>,
    pub(crate) line: Option<u32>,
    pub(crate) args: serde_json::Map<String, serde_json::Value>,
}
