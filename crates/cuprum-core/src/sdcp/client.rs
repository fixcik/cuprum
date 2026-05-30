//! SDCP WebSocket control client (`ws://<ip>:3030/websocket`).
//!
//! Blocking client (tungstenite). Builds the V3.0.0 request envelope and exposes
//! the print-control commands we need. A short socket read timeout lets callers
//! poll for status while still being able to react (e.g. abort on Ctrl-C).

use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
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
