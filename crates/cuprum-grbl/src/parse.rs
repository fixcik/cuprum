//! Parse a single line emitted by GRBL 1.1 into a `Line`, and derive work/machine
//! positions from the periodically-reported work-coordinate offset (`StatusTracker`).

/// GRBL machine state (first field of a status report; substate after ':' ignored).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineState {
    Idle,
    Run,
    Hold,
    Jog,
    Alarm,
    Home,
    Door,
    Check,
    Sleep,
    Unknown,
}

impl MachineState {
    fn parse(token: &str) -> Self {
        // Strip a substate like "Hold:0" / "Door:1".
        match token.split(':').next().unwrap_or(token) {
            "Idle" => Self::Idle,
            "Run" => Self::Run,
            "Hold" => Self::Hold,
            "Jog" => Self::Jog,
            "Alarm" => Self::Alarm,
            "Home" => Self::Home,
            "Door" => Self::Door,
            "Check" => Self::Check,
            "Sleep" => Self::Sleep,
            _ => Self::Unknown,
        }
    }
}

/// Active input pins reported by the `Pn:` status field. GRBL includes this field
/// only while at least one pin is engaged, so an absent field means all clear.
/// We track the per-axis limit switches and the probe; the other letters GRBL may
/// emit here (D door, H hold, R reset, S cycle-start) are ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PinState {
    pub x: bool,
    pub y: bool,
    pub z: bool,
    pub probe: bool,
}

/// A parsed `<...>` status report. `mpos`/`wpos`/`wco` are present only if the line
/// carried them (GRBL sends one of MPos/WPos plus WCO periodically).
#[derive(Debug, Clone, PartialEq)]
pub struct StatusReport {
    pub state: MachineState,
    pub mpos: Option<[f32; 3]>,
    pub wpos: Option<[f32; 3]>,
    pub wco: Option<[f32; 3]>,
    pub feed: f32,
    pub spindle: f32,
    /// Override percentages `[feed, rapid, spindle]` from the `Ov:` field, if present.
    pub overrides: Option<[u8; 3]>,
    /// Active limit/probe pins from the `Pn:` field; all-false when absent.
    pub pins: PinState,
}

/// One line from GRBL, classified.
#[derive(Debug, Clone)]
pub enum Line {
    Status(StatusReport),
    Ok,
    Error(u8),
    Alarm(u8),
    /// Bracketed message/feedback, inner text without the surrounding brackets.
    Message(String),
    Welcome(String),
    Unknown(String),
}

fn parse_triple(s: &str) -> Option<[f32; 3]> {
    let mut it = s.split(',').map(|p| p.trim().parse::<f32>());
    let x = it.next()?.ok()?;
    let y = it.next()?.ok()?;
    let z = it.next()?.ok()?;
    Some([x, y, z])
}

fn parse_overrides(s: &str) -> Option<[u8; 3]> {
    let mut it = s.split(',').map(|p| p.trim().parse::<u8>());
    let feed = it.next()?.ok()?;
    let rapid = it.next()?.ok()?;
    let spindle = it.next()?.ok()?;
    Some([feed, rapid, spindle])
}

/// Decode a `Pn:` value (e.g. `XYZP`) into the limit/probe flags we track.
fn parse_pins(s: &str) -> PinState {
    let mut p = PinState::default();
    for c in s.chars() {
        match c {
            'X' => p.x = true,
            'Y' => p.y = true,
            'Z' => p.z = true,
            'P' => p.probe = true,
            _ => {}
        }
    }
    p
}

fn parse_status(body: &str) -> StatusReport {
    let mut fields = body.split('|');
    let state = MachineState::parse(fields.next().unwrap_or(""));
    let mut report = StatusReport {
        state,
        mpos: None,
        wpos: None,
        wco: None,
        feed: 0.0,
        spindle: 0.0,
        overrides: None,
        pins: PinState::default(),
    };
    for f in fields {
        if let Some(v) = f.strip_prefix("MPos:") {
            report.mpos = parse_triple(v);
        } else if let Some(v) = f.strip_prefix("WPos:") {
            report.wpos = parse_triple(v);
        } else if let Some(v) = f.strip_prefix("WCO:") {
            report.wco = parse_triple(v);
        } else if let Some(v) = f.strip_prefix("FS:") {
            let mut it = v.split(',');
            report.feed = it.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
            report.spindle = it.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
        } else if let Some(v) = f.strip_prefix("F:") {
            report.feed = v.parse().unwrap_or(0.0);
        } else if let Some(v) = f.strip_prefix("Ov:") {
            report.overrides = parse_overrides(v);
        } else if let Some(v) = f.strip_prefix("Pn:") {
            report.pins = parse_pins(v);
        }
    }
    report
}

/// Classify a single trimmed GRBL line.
pub fn parse_line(line: &str) -> Line {
    let line = line.trim();
    if line == "ok" {
        return Line::Ok;
    }
    if let Some(n) = line.strip_prefix("error:") {
        return Line::Error(n.trim().parse().unwrap_or(0));
    }
    if let Some(n) = line.strip_prefix("ALARM:") {
        return Line::Alarm(n.trim().parse().unwrap_or(0));
    }
    if line.starts_with("Grbl ") {
        return Line::Welcome(line.to_string());
    }
    if let Some(inner) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return Line::Message(inner.to_string());
    }
    if let Some(body) = line.strip_prefix('<').and_then(|s| s.strip_suffix('>')) {
        return Line::Status(parse_status(body));
    }
    Line::Unknown(line.to_string())
}

/// Resolved positions: both machine and work coordinates filled in.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedStatus {
    pub state: MachineState,
    pub mpos: [f32; 3],
    pub wpos: [f32; 3],
    pub feed: f32,
    pub spindle: f32,
    /// Override percentages `[feed, rapid, spindle]`; carried over from the last
    /// report that included `Ov:` (GRBL omits it from most reports).
    pub overrides: [u8; 3],
    /// Active limit/probe pins; all-false when no pin is engaged.
    pub pins: PinState,
}

/// Caches fields GRBL reports only intermittently so every resolved status is
/// complete: the work-coordinate offset (WCO) and the override percentages (Ov),
/// both of which GRBL emits once after a change and then omits from most reports.
pub struct StatusTracker {
    wco: [f32; 3],
    overrides: [u8; 3],
}

impl Default for StatusTracker {
    fn default() -> Self {
        // GRBL's power-on overrides are 100 %; hold that until the first Ov: arrives.
        Self {
            wco: [0.0; 3],
            overrides: [100, 100, 100],
        }
    }
}

impl StatusTracker {
    pub fn resolve(&mut self, r: &StatusReport) -> ResolvedStatus {
        if let Some(wco) = r.wco {
            self.wco = wco;
        }
        // Ov: is reported once after it changes, then dropped from subsequent
        // reports. Carry the last-seen value forward instead of snapping back to
        // 100 %, which otherwise makes the UI flicker (e.g. 90 % ↔ 100 %).
        if let Some(ov) = r.overrides {
            self.overrides = ov;
        }
        let sub = |a: [f32; 3]| [a[0] - self.wco[0], a[1] - self.wco[1], a[2] - self.wco[2]];
        let add = |a: [f32; 3]| [a[0] + self.wco[0], a[1] + self.wco[1], a[2] + self.wco[2]];
        let (mpos, wpos) = match (r.mpos, r.wpos) {
            (Some(m), _) => (m, sub(m)),
            (None, Some(w)) => (add(w), w),
            (None, None) => ([0.0; 3], [0.0; 3]),
        };
        ResolvedStatus {
            state: r.state,
            mpos,
            wpos,
            feed: r.feed,
            spindle: r.spindle,
            overrides: self.overrides,
            pins: r.pins,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_replies() {
        assert!(matches!(parse_line("ok"), Line::Ok));
        assert!(matches!(parse_line("error:9"), Line::Error(9)));
        assert!(matches!(parse_line("ALARM:1"), Line::Alarm(1)));
        assert!(matches!(
            parse_line("Grbl 1.1h ['$' for help]"),
            Line::Welcome(_)
        ));
        match parse_line("[MSG:Enabled]") {
            Line::Message(m) => assert_eq!(m, "MSG:Enabled"),
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn parses_status_with_mpos() {
        match parse_line("<Idle|MPos:1.000,2.000,3.000|FS:0,0>") {
            Line::Status(s) => {
                assert_eq!(s.state, MachineState::Idle);
                assert_eq!(s.mpos, Some([1.0, 2.0, 3.0]));
                assert_eq!(s.wpos, None);
                assert_eq!(s.feed, 0.0);
                assert_eq!(s.spindle, 0.0);
            }
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn parses_status_with_wpos_wco_and_fs() {
        match parse_line("<Run|WPos:5.000,0.000,0.000|FS:500,1000|WCO:2.000,3.000,0.000>") {
            Line::Status(s) => {
                assert_eq!(s.state, MachineState::Run);
                assert_eq!(s.wpos, Some([5.0, 0.0, 0.0]));
                assert_eq!(s.wco, Some([2.0, 3.0, 0.0]));
                assert_eq!(s.feed, 500.0);
                assert_eq!(s.spindle, 1000.0);
                // No Ov: field → overrides stay unset (resolved to 100 % later).
                assert_eq!(s.overrides, None);
            }
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn parses_status_with_overrides() {
        match parse_line("<Run|WPos:5.000,0.000,0.000|FS:500,1000|Ov:100,50,75>") {
            Line::Status(s) => {
                assert_eq!(s.state, MachineState::Run);
                assert_eq!(s.overrides, Some([100, 50, 75]));
            }
            other => panic!("expected Status, got {other:?}"),
        }

        // Resolved status fills in the parsed overrides verbatim.
        let mut t = StatusTracker::default();
        if let Line::Status(rep) = parse_line("<Run|MPos:0,0,0|Ov:120,100,80>") {
            assert_eq!(t.resolve(&rep).overrides, [120, 100, 80]);
        } else {
            panic!("expected Status");
        }

        // Missing Ov: → carry the last-seen overrides forward (GRBL omits Ov:
        // from most reports), not snap back to 100 %.
        if let Line::Status(rep) = parse_line("<Idle|MPos:0,0,0|FS:0,0>") {
            assert_eq!(t.resolve(&rep).overrides, [120, 100, 80]);
        } else {
            panic!("expected Status");
        }

        // A fresh tracker reports 100 % until the first Ov: arrives.
        let mut fresh = StatusTracker::default();
        if let Line::Status(rep) = parse_line("<Idle|MPos:0,0,0|FS:0,0>") {
            assert_eq!(fresh.resolve(&rep).overrides, [100, 100, 100]);
        } else {
            panic!("expected Status");
        }
    }

    #[test]
    fn parses_pin_state() {
        // Single axis limit engaged.
        match parse_line("<Idle|MPos:0.000,0.000,0.000|Pn:X>") {
            Line::Status(s) => {
                assert_eq!(
                    s.pins,
                    PinState {
                        x: true,
                        ..Default::default()
                    }
                );
            }
            other => panic!("expected Status, got {other:?}"),
        }
        // All limits plus probe; order/extra letters (D door) don't matter.
        match parse_line("<Alarm|MPos:0.000,0.000,0.000|Pn:PXYZD>") {
            Line::Status(s) => {
                assert_eq!(
                    s.pins,
                    PinState {
                        x: true,
                        y: true,
                        z: true,
                        probe: true
                    }
                );
            }
            other => panic!("expected Status, got {other:?}"),
        }
        // Probe only.
        match parse_line("<Idle|MPos:0.000,0.000,0.000|Pn:P>") {
            Line::Status(s) => {
                assert_eq!(
                    s.pins,
                    PinState {
                        probe: true,
                        ..Default::default()
                    }
                );
            }
            other => panic!("expected Status, got {other:?}"),
        }
        // No Pn: field → all clear, and the flags survive resolve().
        let mut t = StatusTracker::default();
        if let Line::Status(rep) = parse_line("<Idle|MPos:0.000,0.000,0.000|FS:0,0>") {
            assert_eq!(rep.pins, PinState::default());
            assert_eq!(t.resolve(&rep).pins, PinState::default());
        } else {
            panic!("expected Status");
        }
        // resolve() carries the parsed pins through verbatim.
        if let Line::Status(rep) = parse_line("<Idle|MPos:0.000,0.000,0.000|Pn:Y>") {
            assert_eq!(
                t.resolve(&rep).pins,
                PinState {
                    y: true,
                    ..Default::default()
                }
            );
        } else {
            panic!("expected Status");
        }
    }

    #[test]
    fn parses_state_with_substate() {
        assert_eq!(
            status_state("<Hold:0|MPos:0.000,0.000,0.000>"),
            MachineState::Hold
        );
        assert_eq!(
            status_state("<Door:1|MPos:0.000,0.000,0.000>"),
            MachineState::Door
        );
        assert_eq!(
            status_state("<Jog|MPos:0.000,0.000,0.000>"),
            MachineState::Jog
        );
    }

    fn status_state(s: &str) -> MachineState {
        match parse_line(s) {
            Line::Status(st) => st.state,
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn tracker_derives_wpos_from_cached_wco() {
        let mut t = StatusTracker::default();
        let r1 = StatusReport {
            state: MachineState::Idle,
            mpos: Some([10.0, 10.0, 0.0]),
            wpos: None,
            wco: Some([2.0, 3.0, 0.0]),
            feed: 0.0,
            spindle: 0.0,
            overrides: None,
            pins: PinState::default(),
        };
        let s1 = t.resolve(&r1);
        assert_eq!(s1.mpos, [10.0, 10.0, 0.0]);
        assert_eq!(s1.wpos, [8.0, 7.0, 0.0]);

        // Next report omits WCO → tracker reuses the cached one.
        let r2 = StatusReport {
            state: MachineState::Idle,
            mpos: Some([12.0, 10.0, 0.0]),
            wpos: None,
            wco: None,
            feed: 0.0,
            spindle: 0.0,
            overrides: None,
            pins: PinState::default(),
        };
        let s2 = t.resolve(&r2);
        assert_eq!(s2.wpos, [10.0, 7.0, 0.0]);

        // Report carries WPos only → derive MPos = WPos + WCO.
        let r3 = StatusReport {
            state: MachineState::Jog,
            mpos: None,
            wpos: Some([5.0, 0.0, 0.0]),
            wco: None,
            feed: 0.0,
            spindle: 0.0,
            overrides: None,
            pins: PinState::default(),
        };
        let s3 = t.resolve(&r3);
        assert_eq!(s3.mpos, [7.0, 3.0, 0.0]);
    }
}
