//! Ordered, version-keyed JSON transforms. Each is a pure `Value -> Value`
//! step; the pipeline in `super` decides which to apply based on the file's
//! `schema_version`.

use serde_json::Value;

/// v2→v3: the designs array used to be keyed `imports`. Rename the key in place
/// so everything downstream sees `designs`.
pub fn rename_imports_to_designs(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        if let Some(imports) = obj.remove("imports") {
            obj.entry("designs").or_insert(imports);
        }
    }
}

/// v1→v2: each `designs[].gerbers[]` entry was a bare path string. Wrap it into
/// `{ "path": <string>, "layer_type": "other" }`. Runs AFTER the rename, so it
/// only has to look under `designs`.
pub fn gerber_strings_to_objects(v: &mut Value) {
    let Some(designs) = v.get_mut("designs").and_then(Value::as_array_mut) else {
        return;
    };
    for design in designs {
        let Some(gerbers) = design.get_mut("gerbers").and_then(Value::as_array_mut) else {
            continue;
        };
        for g in gerbers {
            if let Some(path) = g.as_str() {
                *g = serde_json::json!({ "path": path, "layer_type": "other" });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rename_moves_imports_to_designs() {
        let mut v = json!({ "imports": [{ "id": "design-1" }] });
        rename_imports_to_designs(&mut v);
        assert!(v.get("imports").is_none());
        assert_eq!(v["designs"][0]["id"], "design-1");
    }

    #[test]
    fn rename_keeps_existing_designs() {
        let mut v = json!({ "designs": [{ "id": "d" }] });
        rename_imports_to_designs(&mut v);
        assert_eq!(v["designs"][0]["id"], "d");
    }

    #[test]
    fn gerbers_string_becomes_object() {
        let mut v = json!({ "designs": [{ "gerbers": ["gerbers/d1/a.gbr"] }] });
        gerber_strings_to_objects(&mut v);
        assert_eq!(v["designs"][0]["gerbers"][0]["path"], "gerbers/d1/a.gbr");
        assert_eq!(v["designs"][0]["gerbers"][0]["layer_type"], "other");
    }

    #[test]
    fn gerbers_object_left_untouched() {
        let mut v = json!({ "designs": [{ "gerbers": [{ "path": "x", "layer_type": "topCopper" }] }] });
        gerber_strings_to_objects(&mut v);
        assert_eq!(v["designs"][0]["gerbers"][0]["layer_type"], "topCopper");
    }
}
