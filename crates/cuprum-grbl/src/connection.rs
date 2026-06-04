//! Blocking serial transport for a GRBL device. `open` returns a split
//! writer/reader pair sharing the same port (one handle for each direction).

use std::io::{self, Read, Write};
use std::time::Duration;

use anyhow::{Context, Result};
use serialport::SerialPort;

/// A serial port the UI can offer for connection.
pub struct PortInfo {
    pub name: String,
    /// "usb" | "bluetooth" | "pci" | "unknown".
    pub kind: String,
}

/// List the serial ports currently present on the system.
pub fn list_ports() -> Result<Vec<PortInfo>> {
    let ports = serialport::available_ports().context("list serial ports")?;
    Ok(ports
        .into_iter()
        .map(|p| PortInfo {
            name: p.port_name,
            kind: match p.port_type {
                serialport::SerialPortType::UsbPort(_) => "usb",
                serialport::SerialPortType::BluetoothPort => "bluetooth",
                serialport::SerialPortType::PciPort => "pci",
                serialport::SerialPortType::Unknown => "unknown",
            }
            .to_string(),
        })
        .collect())
}

/// Open `port` at `baud` and return (writer, reader). The two handles share the
/// underlying device — one is used by command threads to write, the other by the
/// reader thread to read.
pub fn open(port: &str, baud: u32) -> Result<(GrblWriter, GrblReader)> {
    let handle = serialport::new(port, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .with_context(|| format!("open serial port {port} @ {baud}"))?;
    let read_handle = handle.try_clone().context("clone serial handle")?;
    Ok((
        GrblWriter { port: handle },
        GrblReader {
            port: read_handle,
            buf: Vec::with_capacity(256),
        },
    ))
}

/// Write side: lines + real-time bytes.
pub struct GrblWriter {
    port: Box<dyn SerialPort>,
}

impl GrblWriter {
    /// Write `line` followed by '\n' and flush.
    pub fn write_line(&mut self, line: &str) -> Result<()> {
        self.port
            .write_all(line.as_bytes())
            .context("serial write")?;
        self.port.write_all(b"\n").context("serial write")?;
        self.port.flush().context("serial flush")?;
        Ok(())
    }

    /// Write a single real-time byte (e.g. `?`, `!`, `~`, soft-reset) and flush.
    pub fn write_realtime(&mut self, byte: u8) -> Result<()> {
        self.port.write_all(&[byte]).context("serial write")?;
        self.port.flush().context("serial flush")?;
        Ok(())
    }
}

/// Read side: yields complete lines, buffering partial reads across calls.
pub struct GrblReader {
    port: Box<dyn SerialPort>,
    buf: Vec<u8>,
}

impl GrblReader {
    /// Return the next complete line (trailing \r\n stripped), or `None` on a read
    /// timeout (no full line available yet). Errors only on a real I/O failure
    /// (e.g. the device was unplugged).
    pub fn read_line(&mut self) -> Result<Option<String>> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=pos).collect();
                let s = String::from_utf8_lossy(&line);
                return Ok(Some(s.trim_end_matches(['\r', '\n']).to_string()));
            }
            let mut tmp = [0u8; 256];
            match self.port.read(&mut tmp) {
                Ok(0) => return Ok(None),
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) if e.kind() == io::ErrorKind::TimedOut => return Ok(None),
                Err(e) => return Err(e).context("serial read"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_ports_does_not_panic() {
        // On CI there may be no ports; we only assert the call succeeds.
        assert!(list_ports().is_ok());
    }
}
