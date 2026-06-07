//! Encode GRBL commands as the exact strings/bytes to write over serial.

/// Real-time command bytes (sent outside the line-based stream).
pub const STATUS_QUERY: u8 = b'?';
pub const FEED_HOLD: u8 = b'!';
pub const CYCLE_START: u8 = b'~';
pub const SOFT_RESET: u8 = 0x18;
/// Jog cancel: smoothly decelerates and aborts an in-progress jog (continuous jog).
pub const JOG_CANCEL: u8 = 0x85;

// Real-time override bytes (GRBL 1.1). Feed/spindle ratios are clamped by GRBL to
// 10..=200 %; rapid takes only the three fixed steps below.
/// Feed override: reset to 100 %.
pub const FEED_OVERRIDE_100: u8 = 0x90;
/// Feed override: +10 %.
pub const FEED_OVERRIDE_PLUS_10: u8 = 0x91;
/// Feed override: -10 %.
pub const FEED_OVERRIDE_MINUS_10: u8 = 0x92;
/// Feed override: +1 %.
pub const FEED_OVERRIDE_PLUS_1: u8 = 0x93;
/// Feed override: -1 %.
pub const FEED_OVERRIDE_MINUS_1: u8 = 0x94;
/// Rapid override: 100 % (full rapid).
pub const RAPID_OVERRIDE_100: u8 = 0x95;
/// Rapid override: 50 %.
pub const RAPID_OVERRIDE_50: u8 = 0x96;
/// Rapid override: 25 %.
pub const RAPID_OVERRIDE_25: u8 = 0x97;
/// Spindle-speed override: reset to 100 %.
pub const SPINDLE_OVERRIDE_100: u8 = 0x99;
/// Spindle-speed override: +10 %.
pub const SPINDLE_OVERRIDE_PLUS_10: u8 = 0x9A;
/// Spindle-speed override: -10 %.
pub const SPINDLE_OVERRIDE_MINUS_10: u8 = 0x9B;
/// Spindle-speed override: +1 %.
pub const SPINDLE_OVERRIDE_PLUS_1: u8 = 0x9C;
/// Spindle-speed override: -1 %.
pub const SPINDLE_OVERRIDE_MINUS_1: u8 = 0x9D;
/// Toggle Spindle Stop (real-time). Valid only in the Hold state: stops the
/// spindle while paused and is auto-restored on cycle-start (`~`). Also the
/// GRBL "spindle override stop" toggle, hence the alias below.
pub const SPINDLE_OVERRIDE_STOP: u8 = 0x9E;
/// Backwards-compatible alias kept for the Hold-state pause path.
pub const SPINDLE_STOP_TOGGLE: u8 = SPINDLE_OVERRIDE_STOP;

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

/// Absolute jog: `$J=G90 [X..] [Y..] [Z..] F..` in the current work coordinate
/// system. Axes left as `None` are omitted, so a single axis can be jogged
/// without disturbing the others. Absolute (G90) so a re-issued click-to-move
/// targets a fixed point regardless of where a prior jog-cancel decelerated.
pub fn jog_to(x: Option<f32>, y: Option<f32>, z: Option<f32>, feed: f32) -> String {
    let mut s = String::from("$J=G90");
    if let Some(x) = x {
        s.push_str(&format!(" X{x}"));
    }
    if let Some(y) = y {
        s.push_str(&format!(" Y{y}"));
    }
    if let Some(z) = z {
        s.push_str(&format!(" Z{z}"));
    }
    s.push_str(&format!(" F{feed}"));
    s
}

/// Zero the G54 work coordinate system on the selected axes: `G10 L20 P1 ...`.
/// Always targets G54 (P1) — the single work system Cuprum uses everywhere
/// (the drill run's G-code and the restore-after-homing offset are both G54),
/// so manual zeroing can't diverge into a different active WCS.
pub fn set_work_zero(x: bool, y: bool, z: bool) -> String {
    let mut s = String::from("G10 L20 P1");
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
    fn jog_to_is_absolute_and_omits_none_axes() {
        assert_eq!(jog_to(None, None, Some(-5.0), 300.0), "$J=G90 Z-5 F300");
        assert_eq!(
            jog_to(Some(10.0), Some(20.0), None, 100000.0),
            "$J=G90 X10 Y20 F100000"
        );
        assert_eq!(
            jog_to(Some(1.5), Some(-2.0), Some(3.0), 800.0),
            "$J=G90 X1.5 Y-2 Z3 F800"
        );
    }

    #[test]
    fn set_work_zero_selects_axes() {
        assert_eq!(set_work_zero(true, true, true), "G10 L20 P1 X0 Y0 Z0");
        assert_eq!(set_work_zero(true, false, true), "G10 L20 P1 X0 Z0");
        assert_eq!(set_work_zero(false, false, false), "G10 L20 P1");
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
        // Override bytes (GRBL 1.1).
        assert_eq!(FEED_OVERRIDE_100, 0x90);
        assert_eq!(FEED_OVERRIDE_PLUS_10, 0x91);
        assert_eq!(FEED_OVERRIDE_MINUS_10, 0x92);
        assert_eq!(FEED_OVERRIDE_PLUS_1, 0x93);
        assert_eq!(FEED_OVERRIDE_MINUS_1, 0x94);
        assert_eq!(RAPID_OVERRIDE_100, 0x95);
        assert_eq!(RAPID_OVERRIDE_50, 0x96);
        assert_eq!(RAPID_OVERRIDE_25, 0x97);
        assert_eq!(SPINDLE_OVERRIDE_100, 0x99);
        assert_eq!(SPINDLE_OVERRIDE_PLUS_10, 0x9A);
        assert_eq!(SPINDLE_OVERRIDE_MINUS_10, 0x9B);
        assert_eq!(SPINDLE_OVERRIDE_PLUS_1, 0x9C);
        assert_eq!(SPINDLE_OVERRIDE_MINUS_1, 0x9D);
        assert_eq!(SPINDLE_OVERRIDE_STOP, 0x9E);
    }
}
