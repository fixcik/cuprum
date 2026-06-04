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
}

/// Caches the last-seen work-coordinate offset so every report yields both
/// MPos and WPos even when the line carried only one of them.
#[derive(Default)]
pub struct StatusTracker {
    wco: [f32; 3],
}

impl StatusTracker {
    pub fn resolve(&mut self, r: &StatusReport) -> ResolvedStatus {
        if let Some(wco) = r.wco {
            self.wco = wco;
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
            }
            other => panic!("expected Status, got {other:?}"),
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
        };
        let s3 = t.resolve(&r3);
        assert_eq!(s3.mpos, [7.0, 3.0, 0.0]);
    }
}
