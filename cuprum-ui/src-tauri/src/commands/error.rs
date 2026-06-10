//! Uniform error type for `#[tauri::command]` fns.
//!
//! Commands used to return `Result<T, String>` and litter call sites with
//! `.map_err(|e| e.to_string())`, which flattens the error to a single line and
//! drops the cause chain — painful when debugging hardware/project failures.
//!
//! `CmdError` captures the full `{:#}` cause chain (anyhow's alternate form walks
//! every `source()`) at conversion time and serializes to the front-end as that
//! one string, so existing TypeScript that treats invoke errors as strings keeps
//! working while gaining the chained context.
//!
//! The single blanket `From<E: Display>` converts from anyhow errors (with the
//! chain), any `std::error::Error`, and bare `String`/`&str` messages — so `?`
//! and `"msg".into()` just work in command bodies. It does not conflict with the
//! reflexive `From<CmdError>` because `CmdError` deliberately does NOT implement
//! `Display`: a `Display` impl for a local type can only come from this crate, so
//! the compiler can prove the two never overlap.

use std::fmt::Display;

use serde::{Serialize, Serializer};

/// Error returned by Tauri commands. Holds the pre-formatted `{:#}` cause chain.
#[derive(Debug)]
pub struct CmdError(String);

impl CmdError {
    /// The flattened cause-chain message.
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl<E: Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        // `{:#}` walks the whole source chain for anyhow errors; for plain
        // Display/std errors it is just the message.
        Self(format!("{e:#}"))
    }
}

impl Serialize for CmdError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

/// Shorthand for a command's return type.
pub type CmdResult<T> = Result<T, CmdError>;
