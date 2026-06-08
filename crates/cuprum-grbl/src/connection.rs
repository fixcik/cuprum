//! Serial-port discovery for GRBL devices. The live byte transport moved to the
//! async actor (`actor`); this module now only enumerates plausible machine ports.

use anyhow::{Context, Result};

/// A serial port the UI can offer for connection.
pub struct PortInfo {
    pub name: String,
    /// "usb" | "bluetooth" | "pci" | "unknown".
    pub kind: String,
}

/// Whether a (name, kind) pair could plausibly be a machine the user wants to
/// connect to, filtering out the noise the OS exposes as serial ports. Observed
/// on macOS: `serialport` labels every non-USB virtual port (`debug-console`,
/// `Bluetooth-Incoming-Port`, Bluetooth audio like `EDIFIERR990BT`) as `pci`,
/// while real GRBL boards (CH340 `cu.wchusbserial*`, Arduino `cu.usbmodem*`)
/// come through as `usb`. So:
/// - drop the macOS `/dev/tty.*` callin duplicates (we keep the `/dev/cu.*`
///   callout; Linux `/dev/ttyUSB0`/`/dev/ttyACM0` have no dot, so they survive);
/// - drop `pci`/`bluetooth` kinds (virtual / non-machine);
/// - drop names that obviously aren't machines (`debug-console`, `bluetooth`),
///   as a guard in case a platform classifies them differently.
///
/// `usb`/`unknown` ports are kept (a genuine adapter may report `unknown`).
pub fn is_machine_port(name: &str, kind: &str) -> bool {
    if name.starts_with("/dev/tty.") {
        return false;
    }
    if matches!(kind, "pci" | "bluetooth") {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower.contains("debug-console") || lower.contains("bluetooth") {
        return false;
    }
    true
}

/// List the serial ports currently present on the system, filtered to plausible
/// machine candidates (see [`is_machine_port`]).
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
        .filter(|p| is_machine_port(&p.name, &p.kind))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_ports_does_not_panic() {
        // On CI there may be no ports; we only assert the call succeeds.
        assert!(list_ports().is_ok());
    }

    #[test]
    fn keeps_real_usb_machine_ports() {
        // CH340 (GRBL 3018) and Arduino-class boards on macOS.
        assert!(is_machine_port("/dev/cu.wchusbserial114430", "usb"));
        assert!(is_machine_port("/dev/cu.usbmodemSN234567892", "usb"));
        // Linux callout has no dot after `tty`, so it must survive.
        assert!(is_machine_port("/dev/ttyUSB0", "usb"));
        assert!(is_machine_port("/dev/ttyACM0", "usb"));
        // Unknown-classified adapters are kept (could be a real board).
        assert!(is_machine_port("/dev/cu.usbserial-1410", "unknown"));
    }

    #[test]
    fn drops_macos_tty_duplicates() {
        // The `/dev/tty.*` callin duplicates the `/dev/cu.*` callout on macOS.
        assert!(!is_machine_port("/dev/tty.wchusbserial114430", "usb"));
        assert!(!is_machine_port("/dev/tty.usbmodemSN234567892", "usb"));
    }

    #[test]
    fn drops_non_machine_virtual_ports() {
        // macOS reports these as `pci`.
        assert!(!is_machine_port("/dev/cu.debug-console", "pci"));
        assert!(!is_machine_port("/dev/cu.Bluetooth-Incoming-Port", "pci"));
        assert!(!is_machine_port("/dev/cu.EDIFIERR990BT", "pci"));
        // Guard: drop by kind/name even if classified differently.
        assert!(!is_machine_port("/dev/cu.SomeBluetoothThing", "unknown"));
        assert!(!is_machine_port("/dev/cu.debug-console", "unknown"));
    }
}
