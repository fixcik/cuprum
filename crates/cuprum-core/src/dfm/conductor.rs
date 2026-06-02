//! Group connected routed strokes (Line/Arc, Add polarity) into conductors. A
//! conductor is ONE geometrically-connected run of routed copper on a single
//! layer; it carries its neck (min stroke width — the DFM "горлышко"), routed
//! length, and bounding box. This is NOT net-level connectivity: a net crossing a
//! via to another layer, or merging into a zone, is several geometric conductors.

use gerber_viewer::{Exposure, GerberLayer, GerberPrimitive};
use std::collections::HashMap;

/// One geometrically-connected run of routed copper on a single layer.
#[derive(Debug, Clone)]
pub struct Conductor {
    /// Minimum stroke width along the run (mm) — the DFM neck.
    pub neck_mm: f64,
    /// Total routed length (Σ segment lengths, mm).
    pub length_mm: f64,
    /// Axis-aligned bounds.
    pub min: [f64; 2],
    pub max: [f64; 2],
}

/// One routed segment, reduced to endpoints + width + true length.
struct Seg {
    a: [f64; 2],
    b: [f64; 2],
    width: f64,
    length: f64,
}

/// Quantize a point to a ~1µm grid so shared endpoints (exact in the gerber,
/// float-printed by the parser) collide reliably for union-find.
fn key(p: [f64; 2]) -> (i64, i64) {
    (
        (p[0] * 1000.0).round() as i64,
        (p[1] * 1000.0).round() as i64,
    )
}

/// Collect routed segments (Line/Arc, Add, width>0). An arc keeps its chord for
/// connectivity/bbox but its true length `r·|sweep|`.
fn segments(layer: &GerberLayer) -> Vec<Seg> {
    let mut segs = Vec::new();
    for prim in layer.primitives() {
        match prim {
            GerberPrimitive::Line(l) if l.exposure == Exposure::Add && l.width > 0.0 => {
                let a = [l.start.x, l.start.y];
                let b = [l.end.x, l.end.y];
                segs.push(Seg {
                    a,
                    b,
                    width: l.width,
                    length: (b[0] - a[0]).hypot(b[1] - a[1]),
                });
            }
            GerberPrimitive::Arc(a) if a.exposure == Exposure::Add && a.width > 0.0 => {
                let start = [
                    a.center.x + a.radius * a.start_angle.cos(),
                    a.center.y + a.radius * a.start_angle.sin(),
                ];
                let end_ang = a.start_angle + a.sweep_angle;
                let end = [
                    a.center.x + a.radius * end_ang.cos(),
                    a.center.y + a.radius * end_ang.sin(),
                ];
                segs.push(Seg {
                    a: start,
                    b: end,
                    width: a.width,
                    length: a.radius * a.sweep_angle.abs(),
                });
            }
            _ => {}
        }
    }
    segs
}

fn find(parent: &mut [usize], x: usize) -> usize {
    let mut r = x;
    while parent[r] != r {
        r = parent[r];
    }
    let mut c = x;
    while parent[c] != r {
        let next = parent[c];
        parent[c] = r;
        c = next;
    }
    r
}

/// Group routed strokes into conductors by shared endpoints (union-find).
pub fn conductors(layer: &GerberLayer) -> Vec<Conductor> {
    let segs = segments(layer);
    let n = segs.len();
    if n == 0 {
        return Vec::new();
    }
    let mut parent: Vec<usize> = (0..n).collect();
    let mut at: HashMap<(i64, i64), usize> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        for p in [s.a, s.b] {
            let k = key(p);
            if let Some(&j) = at.get(&k) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            } else {
                at.insert(k, i);
            }
        }
    }
    let mut groups: HashMap<usize, Conductor> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        let r = find(&mut parent, i);
        let c = groups.entry(r).or_insert(Conductor {
            neck_mm: f64::INFINITY,
            length_mm: 0.0,
            min: [f64::INFINITY, f64::INFINITY],
            max: [f64::NEG_INFINITY, f64::NEG_INFINITY],
        });
        c.neck_mm = c.neck_mm.min(s.width);
        c.length_mm += s.length;
        for p in [s.a, s.b] {
            c.min[0] = c.min[0].min(p[0]);
            c.min[1] = c.min[1].min(p[1]);
            c.max[0] = c.max[0].max(p[0]);
            c.max[1] = c.max[1].max(p[1]);
        }
    }
    groups.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gerber_viewer::GerberLayer;

    fn layer(bytes: &[u8]) -> GerberLayer {
        let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
        let doc = gerber_viewer::gerber_parser::parse(reader).ok().unwrap();
        GerberLayer::new(doc.into_commands())
    }

    // Two 0.2mm strokes sharing the point (1,0): one conductor, neck 0.2, len ~2.
    #[test]
    fn connected_strokes_are_one_conductor() {
        const G: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\n\
            X0Y0D02*\nX1000000Y0D01*\nX1000000Y0D02*\nX2000000Y0D01*\nM02*\n";
        let cs = conductors(&layer(G));
        assert_eq!(cs.len(), 1, "{cs:?}");
        assert!((cs[0].neck_mm - 0.2).abs() < 1e-6, "neck={}", cs[0].neck_mm);
        assert!(
            (cs[0].length_mm - 2.0).abs() < 1e-3,
            "len={}",
            cs[0].length_mm
        );
    }

    // A right-angle bend is still ONE conductor; neck stays the aperture.
    #[test]
    fn bend_is_one_conductor_neck_is_aperture() {
        const G: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\n\
            X0Y0D02*\nX1000000Y0D01*\nX1000000Y0D02*\nX1000000Y1000000D01*\nM02*\n";
        let cs = conductors(&layer(G));
        assert_eq!(cs.len(), 1, "{cs:?}");
        assert!((cs[0].neck_mm - 0.2).abs() < 1e-6, "neck={}", cs[0].neck_mm);
    }

    // Two disjoint strokes → two conductors.
    #[test]
    fn disjoint_strokes_are_separate_conductors() {
        const G: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\n\
            X0Y0D02*\nX1000000Y0D01*\nX3000000Y0D02*\nX4000000Y0D01*\nM02*\n";
        let cs = conductors(&layer(G));
        assert_eq!(cs.len(), 2, "{cs:?}");
    }
}
