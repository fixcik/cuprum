//! GRBL 1.1 client: serial transport (`connection`), status/line parsing
//! (`parse`) and command encoding (`command`). Synchronous, mirrors the
//! `cuprum-sdcp` leaf-crate idiom. No serde — DTO mapping lives in the UI layer.

pub mod command;
pub mod connection;
pub mod parse;

pub use command::{
    home, jog, set_work_zero, spindle_off, spindle_on, unlock, CYCLE_START, FEED_HOLD, JOG_CANCEL,
    SOFT_RESET, STATUS_QUERY,
};
pub use connection::{list_ports, open, GrblReader, GrblWriter, PortInfo};
pub use parse::{parse_line, Line, MachineState, ResolvedStatus, StatusReport, StatusTracker};
