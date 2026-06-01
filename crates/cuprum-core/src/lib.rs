//! Cuprum core: drive an Elegoo Saturn 4 Ultra 16K as a UV exposure unit for
//! PCB photolithography. Reusable across the CLI prototype and a future Tauri 2 UI.

pub mod cache;
pub mod cal;
pub mod compose;
pub mod conductor;
pub mod diskcache;
pub mod drill;
pub mod geometry;
pub mod gerber;
pub mod goo;
pub mod mesh;
pub mod metrics;
pub mod sdcp;
pub mod svg;
pub mod trace;
