//! SDCP discovery: UDP broadcast `M99999` to :3000, parse the JSON reply.

use std::collections::HashSet;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;

pub const DISCOVERY_PORT: u16 = 3000;
const DISCOVERY_MSG: &[u8] = b"M99999";

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInfo {
    #[serde(rename = "Id")]
    pub id: String,
    #[serde(rename = "Data")]
    pub data: DeviceData,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceData {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "MainboardIP")]
    pub mainboard_ip: String,
    #[serde(rename = "MainboardID")]
    pub mainboard_id: String,
}

/// Broadcast discovery and collect all printers that reply within `timeout`.
pub fn discover(timeout: Duration) -> Result<Vec<DeviceInfo>> {
    let socket = UdpSocket::bind("0.0.0.0:0").context("bind discovery socket")?;
    socket.set_broadcast(true)?;
    socket.set_read_timeout(Some(Duration::from_millis(400)))?;
    socket
        .send_to(DISCOVERY_MSG, ("255.255.255.255", DISCOVERY_PORT))
        .context("send discovery broadcast")?;

    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut buf = [0u8; 65535];
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, src)) => {
                if !seen.insert(src) {
                    continue;
                }
                match serde_json::from_slice::<DeviceInfo>(&buf[..n]) {
                    Ok(dev) => found.push(dev),
                    Err(_) => continue,
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(e) => return Err(e).context("recv discovery reply"),
        }
    }
    Ok(found)
}

/// Discover and return the first printer found, or an error if none replied.
pub fn discover_one(timeout: Duration) -> Result<DeviceInfo> {
    discover(timeout)?
        .into_iter()
        .next()
        .context("no SDCP printer responded to discovery")
}
