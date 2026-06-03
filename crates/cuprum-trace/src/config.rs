//! `CUPRUM_TRACE` parsing and the once-read, process-wide trace config.

use std::path::PathBuf;
use std::sync::OnceLock;

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
pub(crate) fn config() -> &'static TraceConfig {
    static CFG: OnceLock<TraceConfig> = OnceLock::new();
    CFG.get_or_init(|| parse_config(std::env::var("CUPRUM_TRACE").ok().as_deref()))
}

/// Whether tracing is enabled this run.
pub fn is_enabled() -> bool {
    !matches!(config(), TraceConfig::Off)
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
}
