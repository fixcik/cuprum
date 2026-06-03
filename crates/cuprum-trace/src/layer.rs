//! The routing `tracing` layer that sends each span's enter/exit to its
//! operation's file, the once-installed global subscriber, and the dispatch
//! handle that re-parents worker-thread spans.

use std::sync::OnceLock;

use tracing::span::{Attributes, Id};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

use crate::sink::{sink_for, ArgsVisitor, OpIdVisitor, SpanMeta};

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
pub(crate) fn ensure_global_subscriber() {
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
