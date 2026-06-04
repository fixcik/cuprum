use gerber_types::{CoordinateOffset, InterpolationMode, QuadrantMode};
use nalgebra::Point2;

use crate::viewer::layer::primitive::{ArcGerberPrimitive, CircleGerberPrimitive, GerberPrimitive};
use crate::viewer::spacial::ToVector;
use crate::viewer::types::Exposure;

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

    // Calculate center of the arc
    let center_x = current_pos.x + offset_i;
    let center_y = current_pos.y + offset_j;
    let center = Point2::new(center_x, center_y);

    // Calculate radius (distance from current position to center)
    let radius = ((offset_i * offset_i) + (offset_j * offset_j)).sqrt();

    // Calculate start angle (from center to current position)
    let start_angle = (current_pos.y - center.y).atan2(current_pos.x - center.x);

    // Calculate end angle (from center to target position)
    let end_angle = (end.y - center.y).atan2(end.x - center.x);

    // Calculate sweep angle based on interpolation mode
    let mut sweep_angle = match interpolation_mode {
        InterpolationMode::ClockwiseCircular => {
            if end_angle > start_angle {
                end_angle - start_angle - 2.0 * std::f64::consts::PI
            } else {
                end_angle - start_angle
            }
        }
        InterpolationMode::CounterclockwiseCircular => {
            if end_angle < start_angle {
                end_angle - start_angle + 2.0 * std::f64::consts::PI
            } else {
                end_angle - start_angle
            }
        }
        _ => 0.0, // Should never happen
    };

    // Adjust for single/multi quadrant mode
    if let QuadrantMode::Single = quadrant_mode {
        // In single quadrant mode, sweep angle is always <= 90°
        if sweep_angle.abs() > std::f64::consts::PI / 2.0 {
            if sweep_angle > 0.0 {
                sweep_angle = std::f64::consts::PI / 2.0;
            } else {
                sweep_angle = -std::f64::consts::PI / 2.0;
            }
        }
    }

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
