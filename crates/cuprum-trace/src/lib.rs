//! Local, opt-in tracing for profiling heavy pipeline phases.
//!
//! Enabled at runtime via the `CUPRUM_TRACE` env var (see [`parse_config`]). When
//! enabled, ONE process-global subscriber is installed (once) and a custom
//! routing layer writes a separate Chrome Trace Event JSON file per `operation`,
//! keyed by an operation id. A global subscriber (rather than a per-operation
//! thread-scoped one) is required so spans created on shared rayon worker threads
//! are always recorded — a thread-scoped subscriber is silently bypassed on pool
//! workers under concurrency. See the design spec for the root-cause analysis.
//!
//! Split into:
//! - `config` — `CUPRUM_TRACE` parsing + the once-read process config.
//! - `sink` — the per-operation Chrome-trace file writer + span-field visitors.
//! - `layer` — the routing `tracing` layer + global subscriber + dispatch handle.
//! - `session` — the operation/session API, the idle reaper, and `run_with_config`.

mod config;
mod layer;
mod session;
mod sink;

pub use config::{is_enabled, parse_config, TraceConfig};
pub use layer::{capture_dispatch, DispatchHandle};
pub use session::{begin_session, operation, operation_in_session, run_with_config};
