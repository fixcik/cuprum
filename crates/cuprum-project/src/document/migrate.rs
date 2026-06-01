//! Single entry point for loading a `Manifest` from disk. Parses to a JSON
//! `Value`, applies ordered version-keyed steps, then deserializes the upgraded
//! value into the current `Manifest`. `schema_version` is authoritative.
//!
//! EXCEPTION: folding a legacy `panel.json` entry into the manifest is a
//! cross-file migration (it needs a second container entry), so it stays in
//! `lib::open_project` rather than here — see the comment there.

mod steps;

use anyhow::Result;
use serde_json::Value;

use super::manifest::{Manifest, CURRENT_SCHEMA_VERSION};

/// Migrate a raw JSON value to the current `Manifest`.
pub fn manifest_from_value(mut v: Value) -> Result<Manifest> {
    let from = v.get("schema_version").and_then(Value::as_u64).unwrap_or(1) as u32;

    if from > CURRENT_SCHEMA_VERSION {
        anyhow::bail!(
            "manifest schema version {from} is newer than supported ({CURRENT_SCHEMA_VERSION}); update Cuprum to open this project"
        );
    }

    // Steps are ordered by dependency, not strictly by version number: the
    // imports→designs rename must run before gerber normalization, which only
    // looks under `designs`.
    if from < 3 {
        steps::rename_imports_to_designs(&mut v);
    }
    if from < 2 {
        steps::gerber_strings_to_objects(&mut v);
    }

    // Ensure schema_version is present so the Manifest struct (non-optional
    // field) deserializes without error; we overwrite it with the canonical
    // current version immediately after.
    if let Some(obj) = v.as_object_mut() {
        obj.entry("schema_version")
            .or_insert_with(|| serde_json::Value::from(CURRENT_SCHEMA_VERSION));
    }

    let mut m: Manifest = serde_json::from_value(v)?;
    m.schema_version = CURRENT_SCHEMA_VERSION;
    Ok(m)
}

/// Migrate raw manifest bytes to the current `Manifest`.
pub fn manifest_from_slice(bytes: &[u8]) -> Result<Manifest> {
    manifest_from_value(serde_json::from_slice(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::manifest::CURRENT_SCHEMA_VERSION;
    use crate::layer::LayerType;

    #[test]
    fn v1_legacy_shape_migrates() {
        // v1: `imports` key, bare-string gerbers, no schema_version field.
        let bytes = br#"{"name":"x","imports":[
            {"id":"design-1","source_name":"a.zip","gerbers":["gerbers/design-1/a.gbr"]}
        ]}"#;
        let m = manifest_from_slice(bytes).unwrap();
        assert_eq!(m.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(m.designs.len(), 1);
        assert_eq!(m.designs[0].gerbers[0].path, "gerbers/design-1/a.gbr");
        assert_eq!(m.designs[0].gerbers[0].layer_type, LayerType::Other);
    }

    #[test]
    fn v2_legacy_shape_migrates() {
        // v2: still keyed `imports`, but gerbers are already objects.
        let bytes = br#"{"schema_version":2,"name":"x","imports":[
            {"id":"design-1","source_name":"a.zip","gerbers":[{"path":"gerbers/design-1/a.gbr","layer_type":"topCopper"}]}
        ]}"#;
        let m = manifest_from_slice(bytes).unwrap();
        assert_eq!(m.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(m.designs.len(), 1);
        assert_eq!(m.designs[0].gerbers[0].path, "gerbers/design-1/a.gbr");
        assert_eq!(
            m.designs[0].gerbers[0].layer_type,
            crate::layer::LayerType::TopCopper
        );
    }

    #[test]
    fn current_shape_round_trips() {
        let m = Manifest::new("demo");
        let bytes = serde_json::to_vec(&m).unwrap();
        let back = manifest_from_slice(&bytes).unwrap();
        assert_eq!(back.name, "demo");
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn rejects_future_schema_version() {
        let bytes = br#"{"schema_version":999,"name":"x","designs":[]}"#;
        assert!(manifest_from_slice(bytes).is_err());
    }
}
