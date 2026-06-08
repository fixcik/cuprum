//! GRBL 1.1 client: async-actor connection (`actor`), status/line parsing
//! (`parse`) and command encoding (`command`). One tokio task owns the port;
//! callers use a cloneable `GrblHandle`. No serde — DTO mapping lives in the UI
//! layer. The legacy blocking transport in `connection` is retained for port
//! discovery (`list_ports`); its `open`/`GrblReader`/`GrblWriter` are slated for
//! removal once the UI is fully on the actor.

pub mod actor;
pub mod command;
pub mod connection;
pub mod parse;

pub use command::{
    home, jog, jog_to, probe_z, set_work_zero, spindle_off, spindle_on, unlock, CYCLE_START,
    FEED_HOLD, FEED_OVERRIDE_100, FEED_OVERRIDE_MINUS_1, FEED_OVERRIDE_MINUS_10,
    FEED_OVERRIDE_PLUS_1, FEED_OVERRIDE_PLUS_10, JOG_CANCEL, RAPID_OVERRIDE_100, RAPID_OVERRIDE_25,
    RAPID_OVERRIDE_50, SOFT_RESET, SPINDLE_OVERRIDE_100, SPINDLE_OVERRIDE_MINUS_1,
    SPINDLE_OVERRIDE_MINUS_10, SPINDLE_OVERRIDE_PLUS_1, SPINDLE_OVERRIDE_PLUS_10,
    SPINDLE_OVERRIDE_STOP, SPINDLE_STOP_TOGGLE, STATUS_QUERY,
};
pub use actor::{connect, Dir, GrblError, GrblEvent, GrblHandle, GrblLease};
pub use connection::{list_ports, open, GrblReader, GrblWriter, PortInfo};
pub use parse::{
    parse_line, Line, MachineState, PinState, ResolvedStatus, StatusReport, StatusTracker,
};
