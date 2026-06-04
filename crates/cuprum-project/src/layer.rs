//! Gerber layer taxonomy and filename-based classification.
//!
//! Recognises KiCad's gerber job names (`*-F_Cu.gbr`, `*-Edge_Cuts.gbr`, …) and
//! the older Protel/RS-274X extension convention (`.gtl`, `.gbl`, …). Anything
//! unrecognised falls back to [`LayerType::Other`] so the user can map it by hand.

use cuprum_core::mesh::{Role, Side};
use serde::{Deserialize, Serialize};

/// What a gerber/drill file represents. `Ord` so it can key a `BTreeMap`;
/// the JSON form is camelCase (e.g. `"topCopper"`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "camelCase")]
pub enum LayerType {
    TopCopper,
    BottomCopper,
    InnerCopper,
    TopMask,
    BottomMask,
    TopSilk,
    BottomSilk,
    TopPaste,
    BottomPaste,
    EdgeCuts,
    Drill,
    #[default]
    Other,
}

/// Classify a gerber/drill file by its (base) file name.
pub fn classify(filename: &str) -> LayerType {
    let lower = filename.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");

    // Drill first — by extension, since KiCad names are e.g. "board-PTH.drl".
    if matches!(ext, "drl" | "xln" | "nc") || lower.contains("-pth") || lower.contains("-npth") {
        return LayerType::Drill;
    }

    // KiCad job-name suffixes (substring match, case-insensitive).
    if lower.contains("edge_cuts") || lower.contains("edgecuts") {
        return LayerType::EdgeCuts;
    }
    if lower.contains("f_cu") {
        return LayerType::TopCopper;
    }
    if lower.contains("b_cu") {
        return LayerType::BottomCopper;
    }
    if lower.contains("_cu") {
        // In{n}_Cu and anything else copper.
        return LayerType::InnerCopper;
    }
    if lower.contains("f_mask") {
        return LayerType::TopMask;
    }
    if lower.contains("b_mask") {
        return LayerType::BottomMask;
    }
    if lower.contains("f_silk") {
        return LayerType::TopSilk;
    }
    if lower.contains("b_silk") {
        return LayerType::BottomSilk;
    }
    if lower.contains("f_paste") {
        return LayerType::TopPaste;
    }
    if lower.contains("b_paste") {
        return LayerType::BottomPaste;
    }

    // Protel / legacy extensions.
    match ext {
        "gtl" => LayerType::TopCopper,
        "gbl" => LayerType::BottomCopper,
        "gto" => LayerType::TopSilk,
        "gbo" => LayerType::BottomSilk,
        "gts" => LayerType::TopMask,
        "gbs" => LayerType::BottomMask,
        "gtp" => LayerType::TopPaste,
        "gbp" => LayerType::BottomPaste,
        "gko" | "gm1" => LayerType::EdgeCuts,
        _ => LayerType::Other,
    }
}

/// Map a layer type to its 3D/metrics role and board side. Single source of truth
/// shared by the desktop commands and the CLI (was duplicated in the Tauri layer).
pub fn role_side(t: LayerType) -> (Role, Side) {
    use LayerType as LT;
    match t {
        LT::TopCopper | LT::InnerCopper => (Role::Copper, Side::Top),
        LT::BottomCopper => (Role::Copper, Side::Bottom),
        LT::TopMask => (Role::Mask, Side::Top),
        LT::BottomMask => (Role::Mask, Side::Bottom),
        LT::TopSilk => (Role::Silk, Side::Top),
        LT::BottomSilk => (Role::Silk, Side::Bottom),
        LT::TopPaste => (Role::Paste, Side::Top),
        LT::BottomPaste => (Role::Paste, Side::Bottom),
        LT::EdgeCuts => (Role::Edge, Side::Both),
        LT::Drill => (Role::Drill, Side::Both),
        LT::Other => (Role::Other, Side::Top),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_kicad_names() {
        assert_eq!(classify("buck-F_Cu.gbr"), LayerType::TopCopper);
        assert_eq!(classify("buck-B_Cu.gbr"), LayerType::BottomCopper);
        assert_eq!(classify("buck-In1_Cu.gbr"), LayerType::InnerCopper);
        assert_eq!(classify("buck-F_Mask.gbr"), LayerType::TopMask);
        assert_eq!(classify("buck-B_Silkscreen.gbr"), LayerType::BottomSilk);
        assert_eq!(classify("buck-F_Paste.gbr"), LayerType::TopPaste);
        assert_eq!(classify("buck-Edge_Cuts.gbr"), LayerType::EdgeCuts);
        assert_eq!(classify("buck-PTH.drl"), LayerType::Drill);
        assert_eq!(classify("buck.drl"), LayerType::Drill);
    }

    #[test]
    fn classifies_protel_extensions() {
        assert_eq!(classify("board.gtl"), LayerType::TopCopper);
        assert_eq!(classify("board.gbl"), LayerType::BottomCopper);
        assert_eq!(classify("board.gto"), LayerType::TopSilk);
        assert_eq!(classify("board.gbs"), LayerType::BottomMask);
        assert_eq!(classify("board.gko"), LayerType::EdgeCuts);
        assert_eq!(classify("board.xln"), LayerType::Drill);
    }

    #[test]
    fn unknown_is_other() {
        assert_eq!(classify("notes.txt"), LayerType::Other);
        assert_eq!(classify("logo.gbr"), LayerType::Other);
    }

    #[test]
    fn role_side_maps_known_layers() {
        use cuprum_core::mesh::{Role, Side};
        assert_eq!(role_side(LayerType::TopCopper), (Role::Copper, Side::Top));
        assert_eq!(role_side(LayerType::InnerCopper), (Role::Copper, Side::Top));
        assert_eq!(role_side(LayerType::BottomMask), (Role::Mask, Side::Bottom));
        assert_eq!(role_side(LayerType::EdgeCuts), (Role::Edge, Side::Both));
        assert_eq!(role_side(LayerType::Drill), (Role::Drill, Side::Both));
        assert_eq!(role_side(LayerType::Other), (Role::Other, Side::Top));
    }
}
