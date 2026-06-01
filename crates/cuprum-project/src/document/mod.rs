//! Everything that reads, writes, migrates, and snapshots the `.cuprum`
//! document on disk: the ZIP container, the per-open working directory, the
//! manifest/panel schema, restore-point history, and the migration pipeline.

pub mod container;
pub mod history;
pub mod manifest;
pub mod migrate;
pub mod panel;
pub mod workdir;
