//! Coalesce a gerber layer's primitive stream into drawable "runs": chains of
//! connected same-width Line segments become a single Polyline; everything else
//! passes through as a Flash. Shared by the SVG renderer (one `<path>` per
//! polyline) and the geometry stroker (one round-joined stroke instead of a
//! full circle at every segment endpoint), so both paths get lighter input.

use crate::{Exposure, GerberPrimitive};

/// Connectivity tolerance in millimetres: endpoints closer than this are the
/// same point. Much smaller than any real glyph/trace step (~0.05 mm), large
/// enough to absorb f64 noise from the parser.
const JOIN_EPS: f64 = 1e-6;

/// One drawable unit after coalescing.
pub enum Run<'a> {
    /// Circle / Rectangle / Polygon / Arc — passed through untouched.
    Flash(&'a GerberPrimitive),
    /// A chain of connected Line segments sharing width and polarity.
    /// `pts` has >= 2 points; segment i is `pts[i] -> pts[i+1]`.
    Polyline {
        exposure: Exposure,
        width: f64,
        pts: Vec<[f64; 2]>,
    },
}

#[inline]
fn close(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() < JOIN_EPS && (a[1] - b[1]).abs() < JOIN_EPS
}

/// Greedily merge runs of connected Line primitives (same width, same polarity,
/// each segment's start == previous segment's end) into polylines, preserving
/// draw order. Non-Line primitives flush the current run and pass through.
pub fn coalesce_strokes(prims: &[GerberPrimitive]) -> Vec<Run<'_>> {
    let mut out: Vec<Run> = Vec::new();
    let mut cur: Option<(Exposure, f64, Vec<[f64; 2]>)> = None;

    fn flush(cur: &mut Option<(Exposure, f64, Vec<[f64; 2]>)>, out: &mut Vec<Run>) {
        if let Some((exposure, width, pts)) = cur.take() {
            out.push(Run::Polyline {
                exposure,
                width,
                pts,
            });
        }
    }

    for prim in prims {
        match prim {
            GerberPrimitive::Line(l) => {
                let start = [l.start.x, l.start.y];
                let end = [l.end.x, l.end.y];
                let can_extend = matches!(
                    &cur,
                    Some((ex, w, pts))
                        if (*w - l.width).abs() < 1e-9
                            && std::mem::discriminant(ex) == std::mem::discriminant(&l.exposure)
                            && close(*pts.last().unwrap(), start)
                );
                if can_extend {
                    cur.as_mut().unwrap().2.push(end);
                } else {
                    flush(&mut cur, &mut out);
                    cur = Some((l.exposure, l.width, vec![start, end]));
                }
            }
            other => {
                flush(&mut cur, &mut out);
                out.push(Run::Flash(other));
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GerberLayer;

    fn runs(src: &[u8]) -> Vec<(usize, f64)> {
        let reader = std::io::BufReader::new(std::io::Cursor::new(src));
        // Same unpack as svg.rs::render_layer_svg, unwrap in a test context.
        let doc = crate::gerber_parser::parse(reader)
            .map_err(|(_d, e)| format!("{e:?}"))
            .unwrap();
        let layer = GerberLayer::new(doc.into_commands());
        coalesce_strokes(layer.primitives())
            .iter()
            .map(|r| match r {
                Run::Polyline { pts, width, .. } => (pts.len(), *width),
                Run::Flash(_) => (0usize, 0.0f64),
            })
            .collect()
    }

    const TWO_CONNECTED: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.100000*%\nD10*\nX0Y0D02*\nX1000000Y0D01*\nX1000000Y1000000D01*\nM02*\n";
    const GAP: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.100000*%\nD10*\nX0Y0D02*\nX1000000Y0D01*\nX2000000Y0D02*\nX3000000Y0D01*\nM02*\n";
    const WIDTH_CHANGE: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.100000*%\n%ADD11C,0.200000*%\nD10*\nX0Y0D02*\nX1000000Y0D01*\nD11*\nX2000000Y0D01*\nM02*\n";

    #[test]
    fn connected_segments_merge_into_one_polyline() {
        assert_eq!(runs(TWO_CONNECTED), vec![(3, 0.1)]);
    }

    #[test]
    fn pen_up_gap_breaks_the_run() {
        assert_eq!(runs(GAP), vec![(2, 0.1), (2, 0.1)]);
    }

    #[test]
    fn width_change_breaks_the_run() {
        let r = runs(WIDTH_CHANGE);
        assert_eq!(r.len(), 2, "expected two polylines: {r:?}");
        assert_eq!(r[0], (2, 0.1));
        assert_eq!(r[1].1, 0.2);
    }
}
