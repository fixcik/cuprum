//! GRBL 1.1 client: serial transport (`connection`), status/line parsing
//! (`parse`) and command encoding (`command`). Synchronous, mirrors the
//! `cuprum-sdcp` leaf-crate idiom. No serde — DTO mapping lives in the UI layer.

pub mod parse;
