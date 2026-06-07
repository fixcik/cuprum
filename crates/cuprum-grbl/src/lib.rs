//! GRBL 1.1 client: serial transport (`connection`), status/line parsing
//! (`parse`) and command encoding (`command`). Synchronous, mirrors the
//! `cuprum-sdcp` leaf-crate idiom. No serde — DTO mapping lives in the UI layer.

pub mod command;
pub mod connection;
pub mod parse;

pub use command::{
    home, jog, jog_to, set_work_zero, spindle_off, spindle_on, unlock, CYCLE_START, FEED_HOLD,
    FEED_OVERRIDE_100, FEED_OVERRIDE_MINUS_1, FEED_OVERRIDE_MINUS_10, FEED_OVERRIDE_PLUS_1,
    FEED_OVERRIDE_PLUS_10, JOG_CANCEL, RAPID_OVERRIDE_100, RAPID_OVERRIDE_25, RAPID_OVERRIDE_50,
    SOFT_RESET, SPINDLE_OVERRIDE_100, SPINDLE_OVERRIDE_MINUS_1, SPINDLE_OVERRIDE_MINUS_10,
    SPINDLE_OVERRIDE_PLUS_1, SPINDLE_OVERRIDE_PLUS_10, SPINDLE_OVERRIDE_STOP, SPINDLE_STOP_TOGGLE,
    STATUS_QUERY,
};
pub use connection::{list_ports, open, GrblReader, GrblWriter, PortInfo};
pub use parse::{parse_line, Line, MachineState, ResolvedStatus, StatusReport, StatusTracker};
