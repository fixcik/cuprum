//! SDCP (Smart Device Control Protocol) client for Elegoo/Chitu printers.
//!
//! Verified against a Saturn 4 Ultra 16K (firmware V1.5.0, protocol V3.0.0):
//! - discovery: UDP broadcast `M99999` to :3000
//! - control/status: WebSocket :3030
//! - file upload: HTTP multipart to :3030

pub mod client;
pub mod discovery;
pub mod upload;

pub use client::{
    cmd_ack, parse_expose_progress, status_array, ExposeProgress, Session, CMD_START_PRINT,
};
pub use discovery::{discover, discover_one, DeviceInfo};
pub use upload::{upload_file, UploadOutcome};

/// The printer's HTTP/WebSocket control port.
pub const CONTROL_PORT: u16 = 3030;
