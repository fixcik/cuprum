//! Encode GRBL commands as the exact strings/bytes to write over serial.

/// Real-time command bytes (sent outside the line-based stream).
pub const STATUS_QUERY: u8 = b'?';
pub const FEED_HOLD: u8 = b'!';
pub const CYCLE_START: u8 = b'~';
pub const SOFT_RESET: u8 = 0x18;
/// Jog cancel (reserved for continuous jog — not used in Phase 1).
pub const JOG_CANCEL: u8 = 0x85;
/// Toggle Spindle Stop (real-time). Valid only in the Hold state: stops the
/// spindle while paused and is auto-restored on cycle-start (`~`).
pub const SPINDLE_STOP_TOGGLE: u8 = 0x9E;

/// Relative jog: `$J=G91 X.. Y.. Z.. F..`. Axes with a zero delta are omitted.
pub fn jog(dx: f32, dy: f32, dz: f32, feed: f32) -> String {
    let mut s = String::from("$J=G91");
    if dx != 0.0 {
        s.push_str(&format!(" X{dx}"));
    }
    if dy != 0.0 {
        s.push_str(&format!(" Y{dy}"));
    }
    if dz != 0.0 {
        s.push_str(&format!(" Z{dz}"));
    }
    s.push_str(&format!(" F{feed}"));
    s
}

/// Zero the current work coordinate system on the selected axes: `G10 L20 P0 ...`.
pub fn set_work_zero(x: bool, y: bool, z: bool) -> String {
    let mut s = String::from("G10 L20 P0");
    if x {
        s.push_str(" X0");
    }
    if y {
        s.push_str(" Y0");
    }
    if z {
        s.push_str(" Z0");
    }
    s
}

pub fn home() -> &'static str {
    "$H"
}

pub fn unlock() -> &'static str {
    "$X"
}

pub fn spindle_on(rpm: u32) -> String {
    format!("M3 S{rpm}")
}

pub fn spindle_off() -> &'static str {
    "M5"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jog_omits_zero_axes_and_appends_feed() {
        assert_eq!(jog(1.0, 0.0, 0.0, 500.0), "$J=G91 X1 F500");
        assert_eq!(jog(0.0, 0.0, -0.1, 200.0), "$J=G91 Z-0.1 F200");
        assert_eq!(jog(1.0, -2.0, 3.0, 800.0), "$J=G91 X1 Y-2 Z3 F800");
    }

    #[test]
    fn set_work_zero_selects_axes() {
        assert_eq!(set_work_zero(true, true, true), "G10 L20 P0 X0 Y0 Z0");
        assert_eq!(set_work_zero(true, false, true), "G10 L20 P0 X0 Z0");
        assert_eq!(set_work_zero(false, false, false), "G10 L20 P0");
    }

    #[test]
    fn spindle_and_static_commands() {
        assert_eq!(spindle_on(9000), "M3 S9000");
        assert_eq!(spindle_off(), "M5");
        assert_eq!(home(), "$H");
        assert_eq!(unlock(), "$X");
    }

    #[test]
    fn realtime_bytes() {
        assert_eq!(STATUS_QUERY, b'?');
        assert_eq!(FEED_HOLD, b'!');
        assert_eq!(CYCLE_START, b'~');
        assert_eq!(SOFT_RESET, 0x18);
        assert_eq!(JOG_CANCEL, 0x85);
        assert_eq!(SPINDLE_STOP_TOGGLE, 0x9E);
    }
}
