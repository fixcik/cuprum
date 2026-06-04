use gerber_types::{Aperture, Circle, MacroContent, VariableDefinition};
use log::{error, warn};
use nalgebra::{Point2, Vector2};

use crate::viewer::expressions::{
    evaluate_expression, macro_boolean_to_bool, macro_decimal_pair_to_f64, macro_decimal_to_f64,
    macro_integer_to_u32, ExpressionEvaluationError, MacroContext,
};
use crate::viewer::layer::primitive::{
    ArcGerberPrimitive, CircleGerberPrimitive, GerberPolygon, GerberPrimitive,
    RectangleGerberPrimitive,
};
use crate::viewer::types::Exposure;

#[derive(Debug)]
pub(crate) enum ApertureKind {
    Standard(Aperture),
    Macro(Vec<GerberPrimitive>),
}

/// Build the primitives for a flashed standard aperture at `current_pos` and append them.
pub(crate) fn flash_standard_aperture(
    aperture: &Aperture,
    current_pos: Point2<f64>,
    layer_primitives: &mut Vec<GerberPrimitive>,
) {
    match aperture {
        Aperture::Circle(Circle {
            diameter,
            hole_diameter,
        }) => {
            let primitive = if let Some(hole_diameter) = hole_diameter {
                let outer_radius = diameter / 2.0;
                let inner_radius = hole_diameter / 2.0;

                // Mid radius should be the center of where we want our stroke
                let mid_radius = (outer_radius + inner_radius) / 2.0;

                // For StrokeKind::Middle, width should be exactly (outer_radius - inner_radius)
                let width = outer_radius - inner_radius;

                GerberPrimitive::Arc(ArcGerberPrimitive {
                    center: current_pos,
                    radius: mid_radius,
                    width,
                    start_angle: 0.0,
                    sweep_angle: 2.0 * std::f64::consts::PI, // Full circle, clockwise
                    exposure: Exposure::Add,
                })
            } else {
                GerberPrimitive::Circle(CircleGerberPrimitive {
                    center: current_pos,
                    diameter: *diameter,
                    exposure: Exposure::Add,
                })
            };

            layer_primitives.push(primitive);
        }

        Aperture::Rectangle(rect) => {
            layer_primitives.push(GerberPrimitive::Rectangle(RectangleGerberPrimitive {
                origin: Point2::new(current_pos.x - rect.x / 2.0, current_pos.y - rect.y / 2.0),
                width: rect.x,
                height: rect.y,
                exposure: Exposure::Add,
            }));
        }
        Aperture::Polygon(polygon) => {
            let radius = polygon.diameter / 2.0;
            let vertices_count = polygon.vertices as usize;
            let mut vertices = Vec::with_capacity(vertices_count);

            // For standard aperture polygon, we need to generate vertices
            // starting at angle 0 and moving counterclockwise
            for i in 0..vertices_count {
                let angle = (2.0 * std::f64::consts::PI * i as f64) / vertices_count as f64;
                let x = radius * angle.cos();
                let y = radius * angle.sin();

                // Apply rotation if specified
                let final_position = if let Some(rotation) = polygon.rotation {
                    let rot_rad = rotation * std::f64::consts::PI / 180.0;
                    let (sin_rot, cos_rot) = rot_rad.sin_cos();
                    Point2::new(x * cos_rot - y * sin_rot, x * sin_rot + y * cos_rot)
                } else {
                    Point2::new(x, y)
                };

                vertices.push(final_position);
            }

            layer_primitives.push(GerberPrimitive::new_polygon(GerberPolygon {
                center: current_pos,
                vertices,
                exposure: Exposure::Add,
            }));
        }
        Aperture::Obround(rect) => {
            // For an obround, we need to:
            // 1. Create a rectangle for the center part
            // 2. Add two circles (one at each end)
            // The longer dimension determines which way the semicircles go

            let (rect_width, rect_height, circle_centers) = if rect.x > rect.y {
                // Horizontal obround
                let rect_width = rect.x - rect.y; // Subtract circle diameter
                let circle_offset = rect_width / 2.0;
                (
                    rect_width,
                    rect.y,
                    [(circle_offset, 0.0), (-circle_offset, 0.0)],
                )
            } else {
                // Vertical obround
                let rect_height = rect.y - rect.x; // Subtract circle diameter
                let circle_offset = rect_height / 2.0;
                (
                    rect.x,
                    rect_height,
                    [(0.0, circle_offset), (0.0, -circle_offset)],
                )
            };

            // Add the center rectangle
            layer_primitives.push(GerberPrimitive::Rectangle(RectangleGerberPrimitive {
                origin: Point2::new(
                    current_pos.x - rect_width / 2.0,
                    current_pos.y - rect_height / 2.0,
                ),
                width: rect_width,
                height: rect_height,
                exposure: Exposure::Add,
            }));

            // Add the end circles
            let circle_radius = rect.x.min(rect.y) / 2.0;
            for (dx, dy) in circle_centers {
                layer_primitives.push(GerberPrimitive::Circle(CircleGerberPrimitive {
                    center: current_pos + Vector2::new(dx, dy),
                    diameter: circle_radius * 2.0,
                    exposure: Exposure::Add,
                }));
            }
        }
        Aperture::Macro(code, _args) => {
            // if the aperture referred to a macro, and the macro was supported, it will have been handled by the `ApertureKind::Macro` handling.
            warn!("Unsupported macro aperture: {:?}, code: {}", aperture, code);
        }
    }
}

pub(crate) fn process_content(
    content: &MacroContent,
    macro_context: &mut MacroContext,
) -> Result<Option<GerberPrimitive>, ExpressionEvaluationError> {
    match content {
        MacroContent::Circle(circle) => {
            let diameter = macro_decimal_to_f64(&circle.diameter, macro_context)?;
            let (center_x, center_y) = macro_decimal_pair_to_f64(&circle.center, macro_context)?;

            // Get rotation angle and convert to radians
            let rotation_radians = if let Some(angle) = &circle.angle {
                macro_decimal_to_f64(angle, macro_context)? * std::f64::consts::PI / 180.0
            } else {
                0.0
            };

            // Apply rotation to center coordinates around macro origin (0,0)
            let (sin_theta, cos_theta) = rotation_radians.sin_cos();
            let rotated_x = center_x * cos_theta - center_y * sin_theta;
            let rotated_y = center_x * sin_theta + center_y * cos_theta;

            Ok(Some(GerberPrimitive::Circle(CircleGerberPrimitive {
                center: Point2::new(rotated_x, rotated_y),
                diameter,
                exposure: macro_boolean_to_bool(&circle.exposure, macro_context)?.into(),
            })))
        }
        MacroContent::VectorLine(vector_line) => {
            // Get parameters
            let (start_x, start_y) = macro_decimal_pair_to_f64(&vector_line.start, macro_context)?;
            let (end_x, end_y) = macro_decimal_pair_to_f64(&vector_line.end, macro_context)?;
            let width = macro_decimal_to_f64(&vector_line.width, macro_context)?;
            let rotation_angle = macro_decimal_to_f64(&vector_line.angle, macro_context)?;
            let rotation_radians = rotation_angle.to_radians();
            let (sin_theta, cos_theta) = rotation_radians.sin_cos();

            // Rotate start and end points
            let rotated_start_x = start_x * cos_theta - start_y * sin_theta;
            let rotated_start_y = start_x * sin_theta + start_y * cos_theta;
            let rotated_end_x = end_x * cos_theta - end_y * sin_theta;
            let rotated_end_y = end_x * sin_theta + end_y * cos_theta;

            // Calculate direction vector
            let dx = rotated_end_x - rotated_start_x;
            let dy = rotated_end_y - rotated_start_y;
            let length = (dx * dx + dy * dy).sqrt();

            if length == 0.0 {
                return Ok(None);
            }

            // Calculate perpendicular direction
            let ux = dx / length;
            let uy = dy / length;
            let perp_x = -uy;
            let perp_y = ux;

            // Calculate width offsets
            let half_width = width / 2.0;
            let hw_perp_x = perp_x * half_width;
            let hw_perp_y = perp_y * half_width;

            // Calculate corners in absolute coordinates
            let corners = [
                (rotated_start_x - hw_perp_x, rotated_start_y - hw_perp_y),
                (rotated_start_x + hw_perp_x, rotated_start_y + hw_perp_y),
                (rotated_end_x + hw_perp_x, rotated_end_y + hw_perp_y),
                (rotated_end_x - hw_perp_x, rotated_end_y - hw_perp_y),
            ];

            // Calculate center point
            let center_x = (rotated_start_x + rotated_end_x) / 2.0;
            let center_y = (rotated_start_y + rotated_end_y) / 2.0;

            // Convert to relative vertices
            let vertices = corners
                .iter()
                .map(|&(x, y)| Point2::new(x - center_x, y - center_y))
                .collect();

            Ok(Some(GerberPrimitive::new_polygon(GerberPolygon {
                center: Point2::new(center_x, center_y),
                vertices,
                exposure: macro_boolean_to_bool(&vector_line.exposure, macro_context)?.into(),
            })))
        }
        MacroContent::CenterLine(center_line) => {
            // Get parameters
            let (center_x, center_y) =
                macro_decimal_pair_to_f64(&center_line.center, macro_context)?;
            let (length, width) =
                macro_decimal_pair_to_f64(&center_line.dimensions, macro_context)?;
            let rotation_angle = macro_decimal_to_f64(&center_line.angle, macro_context)?;
            let rotation_radians = rotation_angle.to_radians();
            let (sin_theta, cos_theta) = rotation_radians.sin_cos();

            // Calculate half dimensions
            let half_length = length / 2.0;
            let half_width = width / 2.0;

            // Define unrotated vertices relative to center
            let unrotated_vertices = [
                Point2::new(half_length, half_width),
                Point2::new(-half_length, half_width),
                Point2::new(-half_length, -half_width),
                Point2::new(half_length, -half_width),
            ];

            // Rotate each vertex relative to the center
            let vertices = unrotated_vertices
                .iter()
                .map(|pos| {
                    let x = pos.x * cos_theta - pos.y * sin_theta;
                    let y = pos.x * sin_theta + pos.y * cos_theta;
                    Point2::new(x, y)
                })
                .collect();

            Ok(Some(GerberPrimitive::new_polygon(GerberPolygon {
                center: Point2::new(center_x, center_y),
                vertices,
                exposure: macro_boolean_to_bool(&center_line.exposure, macro_context)?.into(),
            })))
        }
        MacroContent::Outline(outline) => {
            // Need at least 3 points to form a polygon
            if outline.points.len() < 3 {
                warn!("Outline with less than 3 points. outline: {:?}", outline);
                return Ok(None);
            }

            // Get vertices - points are already relative to (0,0)
            let mut vertices: Vec<Point2<f64>> = outline
                .points
                .iter()
                .filter_map(|point| {
                    macro_decimal_pair_to_f64(point, macro_context)
                        .map(|(x, y)| Point2::new(x, y))
                        .inspect_err(|err| {
                            error!("Error building vertex: {}", err);
                        })
                        .ok()
                })
                .collect::<Vec<_>>();

            // Get rotation angle and convert to radians
            let rotation_degrees = macro_decimal_to_f64(&outline.angle, macro_context)?;
            let rotation_radians = rotation_degrees * std::f64::consts::PI / 180.0;

            // If there's rotation, apply it to all vertices around (0,0)
            if rotation_radians != 0.0 {
                let (sin_theta, cos_theta) = rotation_radians.sin_cos();
                vertices = vertices
                    .into_iter()
                    .map(|position| {
                        let rotated_x = position.x * cos_theta - position.y * sin_theta;
                        let rotated_y = position.x * sin_theta + position.y * cos_theta;
                        Point2::new(rotated_x, rotated_y)
                    })
                    .collect();
            }

            Ok(Some(GerberPrimitive::new_polygon(GerberPolygon {
                center: Point2::new(0.0, 0.0), // The flash operation will move this to final position
                vertices,
                exposure: macro_boolean_to_bool(&outline.exposure, macro_context)?.into(),
            })))
        }
        MacroContent::Polygon(polygon) => {
            let center = macro_decimal_pair_to_f64(&polygon.center, macro_context)?;

            let vertices_count = macro_integer_to_u32(&polygon.vertices, macro_context)? as usize;
            let diameter = macro_decimal_to_f64(&polygon.diameter, macro_context)?;
            let rotation_degrees = macro_decimal_to_f64(&polygon.angle, macro_context)?;
            let rotation_radians = rotation_degrees * std::f64::consts::PI / 180.0;

            // First generate vertices around (0,0)
            let radius = diameter / 2.0;
            let mut vertices = Vec::with_capacity(vertices_count);
            for i in 0..vertices_count {
                let angle = (2.0 * std::f64::consts::PI * i as f64) / vertices_count as f64;
                let x = radius * angle.cos();
                let y = radius * angle.sin();

                // Apply rotation around macro origin (0,0)
                let (sin_theta, cos_theta) = rotation_radians.sin_cos();
                let rotated_x = x * cos_theta - y * sin_theta;
                let rotated_y = x * sin_theta + y * cos_theta;

                vertices.push(Point2::new(rotated_x, rotated_y));
            }

            // Rotate center point around macro origin
            let (sin_theta, cos_theta) = rotation_radians.sin_cos();
            let rotated_center_x = center.0 * cos_theta - center.1 * sin_theta;
            let rotated_center_y = center.0 * sin_theta + center.1 * cos_theta;

            Ok(Some(GerberPrimitive::new_polygon(GerberPolygon {
                center: Point2::new(rotated_center_x, rotated_center_y),
                vertices,
                exposure: macro_boolean_to_bool(&polygon.exposure, macro_context)?.into(),
            })))
        }
        MacroContent::Moire(_) => {
            error!("Moire not supported");
            Ok(None)
        }
        MacroContent::Thermal(_) => {
            error!("Moire not supported");
            Ok(None)
        }
        MacroContent::VariableDefinition(VariableDefinition { number, expression }) => {
            let result = evaluate_expression(expression, macro_context);
            match result {
                Ok(value) => {
                    macro_context
                        .put(*number, value)
                        .inspect_err(|error| {
                            error!("Error setting variable {}: {}", number, error);
                        })
                        .ok();
                }
                Err(cause) => {
                    error!("Error evaluating expression {}: {}", expression, cause);
                }
            };
            Ok(None)
        }
        MacroContent::Comment(_) => {
            // Nothing to do
            Ok(None)
        }
    }
}
