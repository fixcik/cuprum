//! SDCP WebSocket control client (`ws://<ip>:3030/websocket`).
//!
//! Blocking client (tungstenite). Builds the V3.0.0 request envelope and exposes
//! the print-control commands we need. A short socket read timeout lets callers
//! poll for status while still being able to react (e.g. abort on Ctrl-C).

use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::discovery::DeviceInfo;
use super::CONTROL_PORT;

/// SDCP command numbers (subset we use).
pub const CMD_STATUS: u32 = 0;
pub const CMD_START_PRINT: u32 = 128;
pub const CMD_STOP_PRINT: u32 = 130;
pub const CMD_SKIP_PREHEAT: u32 = 133;

pub struct Session {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    id: String,
    mainboard_id: String,
}

impl Session {
    /// Connect to a discovered device's WebSocket.
    pub fn connect(device: &DeviceInfo) -> Result<Self> {
        Self::connect_to(
            &device.data.mainboard_ip,
            &device.id,
            &device.data.mainboard_id,
        )
    }

    /// Connect by explicit IP + ids (when discovery is bypassed).
    pub fn connect_to(ip: &str, id: &str, mainboard_id: &str) -> Result<Self> {
        let url = format!("ws://{ip}:{CONTROL_PORT}/websocket");
        let (socket, _resp) =
            tungstenite::connect(&url).with_context(|| format!("connect {url}"))?;
        if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
            tcp.set_read_timeout(Some(Duration::from_millis(500)))?;
        }
        Ok(Self {
            socket,
            id: id.to_string(),
            mainboard_id: mainboard_id.to_string(),
        })
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// Send a command with the given inner `Data` payload. Returns the RequestID.
    pub fn send_cmd(&mut self, cmd: u32, data: Value) -> Result<String> {
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let envelope = json!({
            "Id": self.id,
            "Data": {
                "Cmd": cmd,
                "Data": data,
                "RequestID": request_id,
                "MainboardID": self.mainboard_id,
                "TimeStamp": Self::now_secs(),
                "From": 0,
            },
            "Topic": format!("sdcp/request/{}", self.mainboard_id),
        });
        self.socket
            .send(Message::Text(envelope.to_string()))
            .context("send command")?;
        Ok(request_id)
    }

    /// Try to read one JSON message. Returns `None` on read timeout (no message
    /// yet) or for non-text frames; auto-replies to pings.
    pub fn try_recv(&mut self) -> Result<Option<Value>> {
        match self.socket.read() {
            Ok(Message::Text(text)) => {
                let value = serde_json::from_str(&text).context("parse ws message")?;
                Ok(Some(value))
            }
            Ok(Message::Ping(payload)) => {
                let _ = self.socket.send(Message::Pong(payload));
                Ok(None)
            }
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e).context("read ws message"),
        }
    }

    pub fn start_print(&mut self, filename: &str) -> Result<String> {
        self.send_cmd(
            CMD_START_PRINT,
            json!({ "Filename": filename, "StartLayer": 0 }),
        )
    }

    pub fn stop_print(&mut self) -> Result<String> {
        self.send_cmd(CMD_STOP_PRINT, json!({}))
    }

    pub fn skip_preheat(&mut self) -> Result<String> {
        self.send_cmd(CMD_SKIP_PREHEAT, json!({}))
    }

    pub fn request_status(&mut self) -> Result<String> {
        self.send_cmd(CMD_STATUS, json!({}))
    }

    /// Poll until the printer reports idle (`CurrentStatus == [0]`) or `timeout`
    /// elapses (then returns Ok and lets the caller try anyway). The HTTP upload
    /// returns before the file is ingested, so starting too early is rejected.
    pub fn wait_until_idle(&mut self, timeout: Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + timeout;
        self.request_status()?;
        let mut last_ask = std::time::Instant::now();
        while std::time::Instant::now() < deadline {
            if let Some(msg) = self.try_recv()? {
                if status_array(&msg).as_deref() == Some(&[0]) {
                    return Ok(());
                }
            }
            if last_ask.elapsed() > Duration::from_secs(1) {
                self.request_status()?;
                last_ask = std::time::Instant::now();
            }
        }
        Ok(())
    }

    /// Send start-print, retrying while the printer reports busy (Ack != 0).
    pub fn start_print_checked(&mut self, filename: &str, tries: u32) -> Result<()> {
        for attempt in 1..=tries {
            self.start_print(filename)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < deadline {
                if let Some(msg) = self.try_recv()? {
                    if let Some(ack) = cmd_ack(&msg, CMD_START_PRINT) {
                        if ack == 0 {
                            return Ok(());
                        }
                        anyhow::ensure!(
                            attempt < tries,
                            "printer rejected start print (Ack={ack}) after {tries} tries"
                        );
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        anyhow::bail!("no start-print response after {tries} tries")
    }

    /// Request a CMD_STATUS reply and return it as a typed [`ExposeProgress`].
    ///
    /// Mirrors [`Session::wait_until_idle`]: sends the status command, spins on
    /// [`Session::try_recv`], and re-issues the request roughly once a second so
    /// a single dropped poll (the socket read-timeout is short) doesn't blank
    /// the reading. Returns the first reply carrying a `Status` object.
    ///
    /// If the 2 s window elapses with no usable reply, returns an all-`None`
    /// snapshot (logged at debug) instead of erroring, so a caller's progress
    /// loop degrades gracefully rather than aborting.
    pub fn poll_status(&mut self) -> Result<ExposeProgress> {
        self.request_status()?;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut last_ask = std::time::Instant::now();
        while std::time::Instant::now() < deadline {
            if let Some(msg) = self.try_recv()? {
                // Accept any message that carries a Status object.
                if msg.get("Status").is_some() {
                    return Ok(parse_expose_progress(&msg));
                }
            }
            if last_ask.elapsed() > Duration::from_secs(1) {
                self.request_status()?;
                last_ask = std::time::Instant::now();
            }
        }
        tracing::debug!("poll_status: no Status reply within window; returning empty progress");
        Ok(ExposeProgress {
            current_layer: None,
            total_layers: None,
            percent: None,
            remaining_s: None,
            printer_state: None,
        })
    }
}

/// Current-status array from a status push (`Status.CurrentStatus`); `[0]` = idle.
pub fn status_array(msg: &Value) -> Option<Vec<i64>> {
    let arr = msg.get("Status")?.get("CurrentStatus")?.as_array()?;
    Some(arr.iter().filter_map(|v| v.as_i64()).collect())
}

/// The Ack code (`Data.Data.Ack`) from a command response matching `cmd`.
pub fn cmd_ack(msg: &Value, cmd: u32) -> Option<i64> {
    let data = msg.get("Data")?;
    if data.get("Cmd")?.as_u64()? as u32 != cmd {
        return None;
    }
    data.get("Data")?.get("Ack")?.as_i64()
}

// ---------------------------------------------------------------------------
// Typed exposure progress
// ---------------------------------------------------------------------------

/// Live progress snapshot from a CMD_STATUS reply during an active exposure.
///
/// All fields are `Option` — not every firmware version or printer state
/// populates every field.  Field names use camelCase so they round-trip
/// cleanly to the frontend via Tauri `serde_json`.
///
/// JSON source (SDCP V3 protocol, verified on Saturn 4 Ultra):
/// ```json
/// {
///   "Status": {
///     "CurrentStatus": [2],          // [0] = idle, [2] = printing
///     "PrintInfo": {
///       "CurrentLayer": 1,
///       "TotalLayer": 1,
///       "CurrentTicks": 12000,       // elapsed ms
///       "TotalTicks": 30000,         // total estimated ms
///       "Filename": "cuprum-ui.goo"
///     }
///   }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExposeProgress {
    /// Current layer being exposed (1-based, matches the printer's own counter).
    pub current_layer: Option<u32>,
    /// Total number of layers in the job (typically 1 for a PCB single-frame).
    pub total_layers: Option<u32>,
    /// Estimated overall progress in percent (0.0–100.0), derived from ticks
    /// when both CurrentTicks and TotalTicks are present.
    pub percent: Option<f32>,
    /// Estimated seconds remaining, derived from `TotalTicks - CurrentTicks`.
    pub remaining_s: Option<u32>,
    /// Printer state as reported by `CurrentStatus`; e.g. "idle", "printing",
    /// or the raw numeric string when the value is unrecognised.
    pub printer_state: Option<String>,
}

/// Map a raw CMD_STATUS reply [`Value`] into an [`ExposeProgress`].
///
/// Tolerant: any missing or wrong-typed field becomes `None` rather than an
/// error.
pub fn parse_expose_progress(v: &Value) -> ExposeProgress {
    let status = v.get("Status");

    // printer_state: human-readable label derived from CurrentStatus[0]
    let printer_state = status
        .and_then(|s| s.get("CurrentStatus"))
        .and_then(|cs| cs.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_i64())
        .map(|code| match code {
            0 => "idle".to_string(),
            1 => "homing".to_string(),
            2 => "printing".to_string(),
            4 => "file_checking".to_string(),
            _ => code.to_string(),
        });

    let print_info = status.and_then(|s| s.get("PrintInfo"));

    let current_layer = print_info
        .and_then(|pi| pi.get("CurrentLayer"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let total_layers = print_info
        .and_then(|pi| pi.get("TotalLayer"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    // CurrentTicks / TotalTicks are elapsed and total milliseconds.
    let current_ticks = print_info
        .and_then(|pi| pi.get("CurrentTicks"))
        .and_then(|v| v.as_u64());

    let total_ticks = print_info
        .and_then(|pi| pi.get("TotalTicks"))
        .and_then(|v| v.as_u64());

    let percent = match (current_ticks, total_ticks) {
        (Some(c), Some(t)) if t > 0 => Some((c as f32 / t as f32 * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };

    let remaining_s = match (current_ticks, total_ticks) {
        (Some(c), Some(t)) if t > 0 && t >= c => Some(((t - c) / 1000) as u32),
        _ => None,
    };

    ExposeProgress {
        current_layer,
        total_layers,
        percent,
        remaining_s,
        printer_state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Full status reply as the printer emits it during a single-frame PCB exposure.
    fn printing_status_json() -> Value {
        json!({
            "Status": {
                "CurrentStatus": [2],
                "PrintInfo": {
                    "CurrentLayer": 1,
                    "TotalLayer": 1,
                    "CurrentTicks": 12000,
                    "TotalTicks": 30000,
                    "Filename": "cuprum-ui.goo",
                    "TaskId": "abc123"
                }
            }
        })
    }

    #[test]
    fn parses_print_progress_from_status() {
        let v = printing_status_json();
        let p = parse_expose_progress(&v);

        assert_eq!(p.current_layer, Some(1), "CurrentLayer should be 1");
        assert_eq!(p.total_layers, Some(1), "TotalLayer should be 1");

        // percent = 12000 / 30000 * 100 = 40.0
        assert!(
            p.percent.map(|x| (x - 40.0).abs() < 0.01).unwrap_or(false),
            "percent should be ~40.0, got {:?}",
            p.percent
        );

        // remaining = (30000 - 12000) / 1000 = 18 s
        assert_eq!(p.remaining_s, Some(18), "remaining_s should be 18");

        assert_eq!(
            p.printer_state.as_deref(),
            Some("printing"),
            "state code 2 should map to 'printing'"
        );
    }

    #[test]
    fn parses_idle_status() {
        let v = json!({
            "Status": {
                "CurrentStatus": [0]
            }
        });
        let p = parse_expose_progress(&v);

        assert_eq!(p.printer_state.as_deref(), Some("idle"));
        assert_eq!(p.current_layer, None);
        assert_eq!(p.total_layers, None);
        assert_eq!(p.percent, None);
        assert_eq!(p.remaining_s, None);
    }

    #[test]
    fn tolerates_partial_and_empty_json() {
        // Completely empty object — all fields should be None, no panic.
        let empty = parse_expose_progress(&json!({}));
        assert_eq!(empty.current_layer, None);
        assert_eq!(empty.total_layers, None);
        assert_eq!(empty.percent, None);
        assert_eq!(empty.remaining_s, None);
        assert_eq!(empty.printer_state, None);

        // Status present but PrintInfo missing.
        let no_print_info = parse_expose_progress(&json!({
            "Status": { "CurrentStatus": [2] }
        }));
        assert_eq!(no_print_info.printer_state.as_deref(), Some("printing"));
        assert_eq!(no_print_info.current_layer, None);
        assert_eq!(no_print_info.percent, None);

        // PrintInfo present but ticks zero (guard against divide-by-zero).
        let zero_ticks = parse_expose_progress(&json!({
            "Status": {
                "CurrentStatus": [2],
                "PrintInfo": {
                    "CurrentLayer": 1,
                    "TotalLayer": 1,
                    "CurrentTicks": 0,
                    "TotalTicks": 0
                }
            }
        }));
        assert_eq!(zero_ticks.percent, None, "TotalTicks=0 must not divide");
        assert_eq!(zero_ticks.remaining_s, None);

        // TotalTicks < CurrentTicks — defensive check.
        let inverted = parse_expose_progress(&json!({
            "Status": {
                "CurrentStatus": [2],
                "PrintInfo": {
                    "CurrentLayer": 1,
                    "TotalLayer": 1,
                    "CurrentTicks": 9999,
                    "TotalTicks": 5000
                }
            }
        }));
        // percent is clamped (9999/5000 * 100 > 100 → clamped to 100)
        assert_eq!(inverted.percent, Some(100.0));
        // remaining_s: TotalTicks (5000) < CurrentTicks (9999) → None
        assert_eq!(inverted.remaining_s, None);
    }

    #[test]
    fn serializes_to_camel_case() {
        let progress = parse_expose_progress(&printing_status_json());
        let v = serde_json::to_value(&progress).expect("serialize ExposeProgress");
        let obj = v
            .as_object()
            .expect("ExposeProgress serializes to an object");

        // camelCase keys must be present (frontend contract); snake_case absent.
        assert!(obj.contains_key("currentLayer"), "expected camelCase key");
        assert!(obj.contains_key("totalLayers"), "expected camelCase key");
        assert!(obj.contains_key("remainingS"), "expected camelCase key");
        assert!(obj.contains_key("printerState"), "expected camelCase key");
        assert!(
            !obj.contains_key("current_layer"),
            "snake_case key must not leak to the frontend"
        );
    }
}
