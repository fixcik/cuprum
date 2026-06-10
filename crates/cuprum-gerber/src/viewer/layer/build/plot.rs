use std::f64::consts::{FRAC_PI_2, PI};

use gerber_types::{CoordinateOffset, InterpolationMode, QuadrantMode};
use log::warn;
use nalgebra::Point2;

use crate::viewer::layer::primitive::{ArcGerberPrimitive, CircleGerberPrimitive, GerberPrimitive};
use crate::viewer::spacial::ToVector;
use crate::viewer::types::Exposure;

/// Sweep of the arc from `start` to `end` around `center`, signed by the
/// interpolation direction: CCW sweeps are in [0, 2π), CW sweeps in (-2π, 0].
fn directed_sweep(
    start: Point2<f64>,
    end: Point2<f64>,
    center: Point2<f64>,
    interpolation_mode: InterpolationMode,
) -> f64 {
    let start_angle = (start.y - center.y).atan2(start.x - center.x);
    let end_angle = (end.y - center.y).atan2(end.x - center.x);

    match interpolation_mode {
        InterpolationMode::ClockwiseCircular => {
            if end_angle > start_angle {
                end_angle - start_angle - 2.0 * PI
            } else {
                end_angle - start_angle
            }
        }
        InterpolationMode::CounterclockwiseCircular => {
            if end_angle < start_angle {
                end_angle - start_angle + 2.0 * PI
            } else {
                end_angle - start_angle
            }
        }
        _ => 0.0, // Should never happen
    }
}

/// Resolve the true arc center and sweep in single-quadrant mode (G74).
///
/// Per the Gerber spec, I/J in G74 are UNSIGNED magnitudes: the actual center
/// is one of the four sign combinations around the start point. A valid
/// candidate keeps the start/end radii equal and sweeps at most 90 degrees in
/// the commanded direction; among valid candidates the one with the smallest
/// start/end radius mismatch wins. Returns `None` when no candidate produces
/// a valid arc (malformed input).
fn single_quadrant_center_and_sweep(
    start: Point2<f64>,
    end: Point2<f64>,
    offset_i: f64,
    offset_j: f64,
    interpolation_mode: InterpolationMode,
) -> Option<(Point2<f64>, f64)> {
    const EPS: f64 = 1e-9;
    // Be forgiving with files that (incorrectly) carry signs in G74.
    let (i, j) = (offset_i.abs(), offset_j.abs());

    let mut best: Option<(Point2<f64>, f64, f64)> = None; // (center, sweep, radius deviation)
    for (si, sj) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
        let center = Point2::new(start.x + si * i, start.y + sj * j);
        let r_start = ((start.x - center.x).powi(2) + (start.y - center.y).powi(2)).sqrt();
        let r_end = ((end.x - center.x).powi(2) + (end.y - center.y).powi(2)).sqrt();
        let deviation = (r_start - r_end).abs();

        let sweep = directed_sweep(start, end, center, interpolation_mode);
        if sweep.abs() <= EPS || sweep.abs() > FRAC_PI_2 + EPS {
            continue;
        }
        if best.is_none_or(|(_, _, d)| deviation < d) {
            best = Some((center, sweep, deviation));
        }
    }
    best.map(|(center, sweep, _)| (center, sweep))
}

/// Plot a circular-interpolation stroke (G02/G03) and append the resulting primitives.
pub(crate) fn plot_circular_interpolation(
    current_pos: Point2<f64>,
    end: Point2<f64>,
    offset: &CoordinateOffset,
    stroke_width: f64,
    interpolation_mode: InterpolationMode,
    quadrant_mode: QuadrantMode,
    layer_primitives: &mut Vec<GerberPrimitive>,
) {
    // Get I and J offsets (relative to current position)
    let offset_i = offset.x.map(|x| x.into()).unwrap_or(0.0);
    let offset_j = offset.y.map(|y| y.into()).unwrap_or(0.0);

    let (center, sweep_angle) = match quadrant_mode {
        QuadrantMode::Single => single_quadrant_center_and_sweep(
            current_pos,
            end,
            offset_i,
            offset_j,
            interpolation_mode,
        )
        .unwrap_or_else(|| {
            // No candidate yields a <=90 degree arc: malformed input. Fall back
            // to the literal offsets with the sweep clamped (legacy behavior).
            warn!(
                "no valid single-quadrant arc center for I={}, J={}; using literal offsets",
                offset_i, offset_j
            );
            let center = Point2::new(current_pos.x + offset_i, current_pos.y + offset_j);
            let sweep = directed_sweep(current_pos, end, center, interpolation_mode)
                .clamp(-FRAC_PI_2, FRAC_PI_2);
            (center, sweep)
        }),
        QuadrantMode::Multi => {
            let center = Point2::new(current_pos.x + offset_i, current_pos.y + offset_j);
            let sweep = directed_sweep(current_pos, end, center, interpolation_mode);
            (center, sweep)
        }
    };

    // Calculate radius (distance from current position to center)
    let radius = ((current_pos.x - center.x).powi(2) + (current_pos.y - center.y).powi(2)).sqrt();

    // Calculate start angle (from center to current position)
    let start_angle = (current_pos.y - center.y).atan2(current_pos.x - center.x);

    let arc_primitive = ArcGerberPrimitive {
        center,
        radius,
        width: stroke_width,
        start_angle,
        sweep_angle,
        exposure: Exposure::Add,
    };

    if arc_primitive.is_full_circle() {
        // add the arc primitive
        layer_primitives.push(GerberPrimitive::Arc(arc_primitive));
    } else {
        let points = arc_primitive.generate_points();

        // draw a circle primitive at the start
        let start_point = points.first().unwrap();
        layer_primitives.push(GerberPrimitive::Circle(CircleGerberPrimitive {
            center: start_point + center.to_vector(),
            diameter: stroke_width,
            exposure: Exposure::Add,
        }));

        layer_primitives.push(GerberPrimitive::Arc(arc_primitive));

        // draw a circle primitive at the end
        let end_point = points.last().unwrap();
        layer_primitives.push(GerberPrimitive::Circle(CircleGerberPrimitive {
            center: end_point + center.to_vector(),
            diameter: stroke_width,
            exposure: Exposure::Add,
        }));
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::FRAC_PI_2;

    use gerber_types::{
        CoordinateFormat, CoordinateMode, CoordinateNumber, CoordinateOffset, InterpolationMode,
        QuadrantMode, ZeroOmission,
    };
    use nalgebra::Point2;

    use super::*;
    use crate::viewer::layer::primitive::ArcGerberPrimitive;

    fn offset(i: f64, j: f64) -> CoordinateOffset {
        let format = CoordinateFormat::new(ZeroOmission::Leading, CoordinateMode::Absolute, 3, 5);
        CoordinateOffset::new(
            CoordinateNumber::try_from(i).unwrap(),
            CoordinateNumber::try_from(j).unwrap(),
            format,
        )
    }

    fn plot_single_arc(
        start: Point2<f64>,
        end: Point2<f64>,
        i: f64,
        j: f64,
        mode: InterpolationMode,
    ) -> ArcGerberPrimitive {
        let mut primitives = Vec::new();
        plot_circular_interpolation(
            start,
            end,
            &offset(i, j),
            0.1,
            mode,
            QuadrantMode::Single,
            &mut primitives,
        );
        primitives
            .iter()
            .find_map(|p| match p {
                GerberPrimitive::Arc(arc) => Some(arc.clone()),
                _ => None,
            })
            .expect("an arc primitive")
    }

    fn dist(a: Point2<f64>, b: Point2<f64>) -> f64 {
        let d = a - b;
        (d.x * d.x + d.y * d.y).sqrt()
    }

    fn arc_endpoint(arc: &ArcGerberPrimitive) -> Point2<f64> {
        let angle = arc.start_angle + arc.sweep_angle;
        Point2::new(
            arc.center.x + arc.radius * angle.cos(),
            arc.center.y + arc.radius * angle.sin(),
        )
    }

    #[test]
    fn single_quadrant_center_in_second_quadrant_relative_to_start() {
        // CCW arc from (10,0) to (0,10) centered at the origin. The true center
        // offset from the start is (-10, 0), but G74 supplies unsigned I=10 J=0.
        let start = Point2::new(10.0, 0.0);
        let end = Point2::new(0.0, 10.0);
        let arc = plot_single_arc(
            start,
            end,
            10.0,
            0.0,
            InterpolationMode::CounterclockwiseCircular,
        );

        assert!(
            arc.center.x.abs() < 1e-6 && arc.center.y.abs() < 1e-6,
            "center must be at the origin, got {:?}",
            arc.center
        );
        let endpoint = arc_endpoint(&arc);
        assert!(
            dist(endpoint, end) < 1e-6,
            "arc must end at the commanded endpoint, got {:?}",
            endpoint
        );
        assert!((arc.sweep_angle - FRAC_PI_2).abs() < 1e-9);
    }

    #[test]
    fn single_quadrant_center_in_third_quadrant_relative_to_start() {
        // CW arc from (10,10) to (10,-10) centered at the origin. The true
        // center offset from the start is (-10, -10); G74 supplies I=10 J=10.
        // The mirrored candidate (20,0) also has equal start/end radii but
        // sweeps 270 degrees, so the candidate search must reject it.
        let start = Point2::new(10.0, 10.0);
        let end = Point2::new(10.0, -10.0);
        let arc = plot_single_arc(start, end, 10.0, 10.0, InterpolationMode::ClockwiseCircular);

        assert!(
            arc.center.x.abs() < 1e-6 && arc.center.y.abs() < 1e-6,
            "center must be at the origin, got {:?}",
            arc.center
        );
        let endpoint = arc_endpoint(&arc);
        assert!(
            dist(endpoint, end) < 1e-6,
            "arc must end at the commanded endpoint, got {:?}",
            endpoint
        );
        assert!((arc.sweep_angle + FRAC_PI_2).abs() < 1e-9);
    }

    #[test]
    fn single_quadrant_first_quadrant_center_still_works() {
        // CCW quarter arc from (5,15) to (0,10) centered at (5,10): the center
        // offset (0,-5) is "below" the start, supplied unsigned as I=0 J=5.
        let start = Point2::new(5.0, 15.0);
        let end = Point2::new(0.0, 10.0);
        let arc = plot_single_arc(
            start,
            end,
            0.0,
            5.0,
            InterpolationMode::CounterclockwiseCircular,
        );

        assert!(
            dist(arc.center, Point2::new(5.0, 10.0)) < 1e-6,
            "center must be (5,10), got {:?}",
            arc.center
        );
        let endpoint = arc_endpoint(&arc);
        assert!(dist(endpoint, end) < 1e-6);
    }
}
