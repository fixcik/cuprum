//! Minimal Excellon (.drl) parser — enough to place drilled holes for the 3D
//! board preview. Targets KiCad-style metric files (tool table + decimal
//! coordinates). Routed slots (G00/G01 milling) and implied-decimal /
//! zero-suppressed coordinate formats are out of scope for v1.
//!
//! A genuinely empty body (header only — e.g. KiCad's NPTH file when the board
//! has no non-plated holes) yields an empty hole list. But a body that DOES
//! carry coordinate data we couldn't turn into holes (missing tool table,
//! unsupported coordinate format) is reported as an error rather than silently
//! looking the same as "no holes".

use anyhow::{bail, Result};
use std::collections::HashMap;

/// A drilled hole: centre (mm) and diameter (mm).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hole {
    pub x_mm: f32,
    pub y_mm: f32,
    pub d_mm: f32,
}

/// A routed/oval slot: from `a` to `b` (mm), `w_mm` = tool (slot) width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    pub a: [f32; 2],
    pub b: [f32; 2],
    pub w_mm: f32,
}

/// Parse Excellon bytes into drilled holes. Best-effort: unknown lines are skipped.
pub fn parse_drill(bytes: &[u8]) -> Result<Vec<Hole>> {
    let text = String::from_utf8_lossy(bytes);
    let mut inch = false; // KiCad default is METRIC
    let mut tools: HashMap<u32, f32> = HashMap::new();
    let mut cur_d: f32 = 0.0;
    let (mut last_x, mut last_y) = (0.0_f32, 0.0_f32);
    let mut holes = Vec::new();
    let mut saw_coord = false; // did the body carry any X/Y drill coordinates?

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if line.starts_with("INCH") {
            inch = true;
            continue;
        }
        if line.starts_with("METRIC") {
            inch = false;
            continue;
        }
        // Tool definition (header): "T1C0.300"
        if line.starts_with('T') && line.contains('C') {
            if let (Some(t), Some(d)) = (tool_num(line), num_after(line, 'C')) {
                tools.insert(t, d);
            }
            continue;
        }
        // Tool select (body): "T1"
        if line.starts_with('T') {
            if let Some(t) = tool_num(line) {
                cur_d = *tools.get(&t).unwrap_or(&cur_d);
            }
            continue;
        }
        // Coordinate hit: "X10.0Y10.0" (X or Y may be omitted → carry last)
        if line.starts_with('X') || line.starts_with('Y') {
            saw_coord = true;
            if let Some(x) = num_after(line, 'X') {
                last_x = x;
            }
            if let Some(y) = num_after(line, 'Y') {
                last_y = y;
            }
            if cur_d > 0.0 {
                let k = if inch { 25.4 } else { 1.0 };
                holes.push(Hole { x_mm: last_x * k, y_mm: last_y * k, d_mm: cur_d * k });
            }
        }
    }
    // Coordinates were present but none produced a hole → we failed to understand
    // the body (no tool table, or an unsupported coordinate format). Surface it as
    // an error so the UI can say "ошибка парсинга" instead of "нет отверстий".
    if holes.is_empty() && saw_coord {
        bail!("drill body carries coordinates but no holes could be parsed (unsupported format or missing tool table)");
    }
    Ok(holes)
}

/// Parse routed/oval slots — KiCad's `G85` canned slot form
/// (`X<a>Y<a>G85X<b>Y<b>`), the tool diameter being the slot width. Other
/// routing dialects (M15/M16 + G01) are out of scope; an unrecognised body
/// yields an empty list. Best-effort, never errors.
pub fn parse_slots(bytes: &[u8]) -> Vec<Slot> {
    let text = String::from_utf8_lossy(bytes);
    let mut inch = false;
    let mut tools: HashMap<u32, f32> = HashMap::new();
    let mut cur_d: f32 = 0.0;
    let (mut last_x, mut last_y) = (0.0_f32, 0.0_f32);
    let mut slots = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if line.starts_with("INCH") {
            inch = true;
            continue;
        }
        if line.starts_with("METRIC") {
            inch = false;
            continue;
        }
        if line.starts_with('T') && line.contains('C') {
            if let (Some(t), Some(d)) = (tool_num(line), num_after(line, 'C')) {
                tools.insert(t, d);
            }
            continue;
        }
        if line.starts_with('T') {
            if let Some(t) = tool_num(line) {
                cur_d = *tools.get(&t).unwrap_or(&cur_d);
            }
            continue;
        }
        let k = if inch { 25.4 } else { 1.0 };
        if let Some(g) = line.find("G85") {
            // Start = coords before G85 (carry last if absent); end = after.
            let (head, tail) = (&line[..g], &line[g + 3..]);
            let ax = num_after(head, 'X').unwrap_or(last_x);
            let ay = num_after(head, 'Y').unwrap_or(last_y);
            let bx = num_after(tail, 'X').unwrap_or(ax);
            let by = num_after(tail, 'Y').unwrap_or(ay);
            if cur_d > 0.0 {
                slots.push(Slot { a: [ax * k, ay * k], b: [bx * k, by * k], w_mm: cur_d * k });
            }
            last_x = bx;
            last_y = by;
        } else if line.starts_with('X') || line.starts_with('Y') {
            if let Some(x) = num_after(line, 'X') {
                last_x = x;
            }
            if let Some(y) = num_after(line, 'Y') {
                last_y = y;
            }
        }
    }
    slots
}

/// Digits right after a leading `T` (stops at the first non-digit, e.g. `C`).
fn tool_num(line: &str) -> Option<u32> {
    line[1..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// The decimal number following `marker` (requires a literal decimal/digits).
fn num_after(line: &str, marker: char) -> Option<f32> {
    let idx = line.find(marker)?;
    let s: String = line[idx + 1..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
        .collect();
    if s.is_empty() {
        return None;
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] =
        b"M48\nMETRIC\nT1C0.300\nT2C0.800\n%\nG90\nT1\nX10.0Y10.0\nX20.0Y10.0\nT2\nX15.5Y20.25\nM30\n";

    #[test]
    fn parses_metric_tools_and_hits() {
        let h = parse_drill(SAMPLE).unwrap();
        assert_eq!(h.len(), 3, "{h:?}");
        assert_eq!(h[0], Hole { x_mm: 10.0, y_mm: 10.0, d_mm: 0.3 });
        assert_eq!(h[1], Hole { x_mm: 20.0, y_mm: 10.0, d_mm: 0.3 });
        assert_eq!(h[2], Hole { x_mm: 15.5, y_mm: 20.25, d_mm: 0.8 });
    }

    #[test]
    fn inch_converts_to_mm() {
        let drl = b"M48\nINCH\nT1C0.0394\n%\nT1\nX1.0Y0.5\nM30\n";
        let h = parse_drill(drl).unwrap();
        assert_eq!(h.len(), 1);
        assert!((h[0].x_mm - 25.4).abs() < 0.01, "{:?}", h[0]);
        assert!((h[0].d_mm - 1.0).abs() < 0.01, "{:?}", h[0]);
    }

    #[test]
    fn unknown_body_is_empty_not_error() {
        assert_eq!(parse_drill(b"garbage\nno tools\n").unwrap().len(), 0);
    }

    #[test]
    fn empty_npth_body_is_ok_and_empty() {
        // KiCad's NPTH file when the board has no non-plated holes: header only,
        // no tool table, no coordinates → legitimately empty, not an error.
        let drl = b"M48\nMETRIC\n%\nG90\nG05\nM30\n";
        assert_eq!(parse_drill(drl).unwrap().len(), 0);
    }

    #[test]
    fn parses_g85_slots() {
        // One 1.0 mm-wide slot from (10,10) to (20,10).
        let drl = b"M48\nMETRIC,TZ\nT1C1.000\n%\nT1\nX10.0Y10.0G85X20.0Y10.0\nM30\n";
        let s = parse_slots(drl);
        assert_eq!(s.len(), 1, "{s:?}");
        assert_eq!(s[0], Slot { a: [10.0, 10.0], b: [20.0, 10.0], w_mm: 1.0 });
    }

    #[test]
    fn plain_holes_yield_no_slots() {
        assert!(parse_slots(SAMPLE).is_empty());
    }

    #[test]
    fn coords_without_tool_table_is_parse_error() {
        // Coordinate hits but no tool was ever selected → we can't size the holes,
        // so this is a parse failure rather than a silent empty list.
        let drl = b"M48\nMETRIC\n%\nG90\nX10.0Y10.0\nX20.0Y10.0\nM30\n";
        assert!(parse_drill(drl).is_err());
    }
}
