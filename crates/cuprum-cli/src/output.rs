//! Output helpers: human vs --json, and process exit codes.

/// Process exit codes. 0 = success, 1 = tool error, 2 = DFM gate failure.
pub const EXIT_OK: i32 = 0;
pub const EXIT_ERR: i32 = 1;
#[allow(dead_code)]
pub const EXIT_GATE_FAIL: i32 = 2;

/// Print an error as `{"error": "..."}` (json) or a plain line, to stderr.
pub fn print_error(json: bool, msg: &str) {
    if json {
        eprintln!("{}", serde_json::json!({ "error": msg }));
    } else {
        eprintln!("error: {msg}");
    }
}
