pub mod info;
pub mod mesh;
pub mod render;
pub mod svg;

use cuprum_project::layer::LayerType;

/// The camelCase string the preview/compose pipeline keys layers by (e.g.
/// `TopCopper` → `"topCopper"`). `LayerType` is a `#[serde(rename_all =
/// "camelCase")]` unit enum, so this is always a non-empty string.
pub fn type_key(t: LayerType) -> String {
    let s = serde_json::to_value(t)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    debug_assert!(!s.is_empty(), "type_key returned empty for {t:?}");
    s
}
