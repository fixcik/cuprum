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

/// Upper bound for a single `recv_from` wait. Each poll waits at most this long
/// (or less when the deadline is closer), so `discover` returns close to its
/// `timeout` instead of overshooting by a whole fixed read-timeout.
const POLL_MAX: Duration = Duration::from_millis(400);

/// Socket read timeout for the next poll: the time left until `deadline`,
/// capped at [`POLL_MAX`]. `None` once the deadline has passed — stop polling
/// (a zero read timeout would be rejected by `set_read_timeout` anyway).
fn poll_read_timeout(deadline: Instant, now: Instant) -> Option<Duration> {
    let remaining = deadline.saturating_duration_since(now);
    if remaining.is_zero() {
        None
    } else {
        Some(remaining.min(POLL_MAX))
    }
}

/// Broadcast discovery and collect all printers that reply within `timeout`.
pub fn discover(timeout: Duration) -> Result<Vec<DeviceInfo>> {
    let socket = UdpSocket::bind("0.0.0.0:0").context("bind discovery socket")?;
    socket.set_broadcast(true)?;
    socket
        .send_to(DISCOVERY_MSG, ("255.255.255.255", DISCOVERY_PORT))
        .context("send discovery broadcast")?;

    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut buf = [0u8; 65535];
    let deadline = Instant::now() + timeout;
    while let Some(read_timeout) = poll_read_timeout(deadline, Instant::now()) {
        socket.set_read_timeout(Some(read_timeout))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_read_timeout_caps_at_poll_max() {
        let now = Instant::now();
        assert_eq!(
            poll_read_timeout(now + Duration::from_secs(10), now),
            Some(POLL_MAX),
            "far deadline polls at the cap"
        );
    }

    #[test]
    fn poll_read_timeout_shrinks_near_deadline() {
        let now = Instant::now();
        assert_eq!(
            poll_read_timeout(now + Duration::from_millis(150), now),
            Some(Duration::from_millis(150)),
            "last poll must not overshoot the caller's deadline"
        );
    }

    #[test]
    fn poll_read_timeout_none_when_expired() {
        let now = Instant::now();
        assert_eq!(poll_read_timeout(now, now), None, "deadline reached");
        assert_eq!(
            poll_read_timeout(now, now + Duration::from_millis(1)),
            None,
            "deadline passed"
        );
    }
}
