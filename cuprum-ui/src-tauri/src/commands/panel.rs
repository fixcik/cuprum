//! Panel packing command — thin proxy to the `cuprum-nest` solver. The dense
//! search is the heavy part of panelization, so it runs in Rust (off the UI
//! thread); the frontend keeps only a light greedy packer for live preview.

use cuprum_nest::{pack, PackInput, Placement, Rect};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPanelReq {
    pub board_w: f64,
    pub board_h: f64,
    pub panel_w: f64,
    pub panel_h: f64,
    pub requested: usize,
    pub margin_mm: f64,
    pub gap_mm: f64,
    pub clearance_mm: f64,
    pub mix_rotation: bool,
    pub force_rotate: bool,
    pub obstacles: Vec<PackBox>,
    pub time_budget_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPlacement {
    pub x: f64,
    pub y: f64,
    pub rotated: bool,
}

/// Pack up to `requested` copies of a board onto the panel, avoiding obstacles.
/// Returns each placed footprint's top-left (mm) and its 90° flag.
#[tauri::command]
pub fn pack_panel(req: PackPanelReq) -> Vec<PackPlacement> {
    let input = PackInput {
        board_w: req.board_w,
        board_h: req.board_h,
        panel_w: req.panel_w,
        panel_h: req.panel_h,
        requested: req.requested,
        margin_mm: req.margin_mm,
        gap_mm: req.gap_mm,
        clearance_mm: req.clearance_mm,
        mix_rotation: req.mix_rotation,
        force_rotate: req.force_rotate,
        obstacles: req
            .obstacles
            .into_iter()
            .map(|b| Rect {
                min_x: b.min_x,
                min_y: b.min_y,
                max_x: b.max_x,
                max_y: b.max_y,
            })
            .collect(),
        time_budget_ms: req.time_budget_ms,
    };
    pack(&input)
        .into_iter()
        .map(|Placement { x, y, rotated }| PackPlacement { x, y, rotated })
        .collect()
}
