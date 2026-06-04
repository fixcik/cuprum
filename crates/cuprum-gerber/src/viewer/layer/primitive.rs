use std::sync::Arc;

use log::trace;
use nalgebra::Point2;

use crate::viewer::geometry;
use crate::viewer::spacial::deduplicate::DedupEpsilon;
use crate::viewer::types::{Exposure, Winding};

#[derive(Debug, Clone)]
pub enum GerberPrimitive {
    Circle(CircleGerberPrimitive),
    Rectangle(RectangleGerberPrimitive),
    Line(LineGerberPrimitive),
    Arc(ArcGerberPrimitive),
    Polygon(PolygonGerberPrimitive),
}

#[derive(Debug, Clone)]
pub struct CircleGerberPrimitive {
    pub center: Point2<f64>,
    pub diameter: f64,
    pub exposure: Exposure,
}

#[derive(Debug, Clone)]
pub struct RectangleGerberPrimitive {
    pub origin: Point2<f64>,
    pub width: f64,
    pub height: f64,
    pub exposure: Exposure,
}

#[derive(Debug, Clone)]
pub struct LineGerberPrimitive {
    pub start: Point2<f64>,
    pub end: Point2<f64>,
    pub width: f64,
    pub exposure: Exposure,
}

#[derive(Debug, Clone)]
pub struct PolygonGerberPrimitive {
    pub center: Point2<f64>,
    pub exposure: Exposure,
    pub geometry: Arc<PolygonGeometry>,
}

#[derive(Debug, Clone)]
pub struct ArcGerberPrimitive {
    pub center: Point2<f64>,
    pub radius: f64,
    pub width: f64,
    pub start_angle: f64, // in radians
    pub sweep_angle: f64, // in radians, positive = clockwise
    pub exposure: Exposure,
}

impl ArcGerberPrimitive {
    /// Spec 4.7.2 "When start point and end point coincide the result is a full 360° arc"
    ///
    /// However, we to avoid being to strict due to rounding errors.
    pub fn is_full_circle(&self) -> bool {
        // A full circle in Gerber is either:
        // 1. Sweep angle is exactly 0 (special Gerber convention)
        // 2. Sweep angle is exactly 2π (360 degrees)
        const EPSILON: f64 = 1e-10;

        // Check for zero sweep (Gerber convention for full circle)
        if self.sweep_angle.abs() < EPSILON {
            return true;
        }

        // Check for 2π sweep (360 degrees)
        let normalized_sweep = (self.sweep_angle.abs() - 2.0 * std::f64::consts::PI).abs();
        if normalized_sweep < EPSILON {
            return true;
        }

        false
    }

    pub fn generate_points(&self) -> Vec<Point2<f64>> {
        let Self {
            radius,
            start_angle,
            sweep_angle,
            ..
        } = self;

        // Check if this is a full circle
        let is_full_circle = self.is_full_circle();

        let steps = if is_full_circle { 33 } else { 32 };

        let effective_sweep = if is_full_circle {
            2.0 * std::f64::consts::PI
        } else {
            *sweep_angle
        };

        // Calculate the absolute sweep for determining the step size
        let abs_sweep = effective_sweep.abs();
        let angle_step = abs_sweep / (steps - 1) as f64;

        // Generate points along the outer radius
        let mut points = Vec::with_capacity(steps);
        for i in 0..steps {
            // Adjust the angle based on sweep direction
            let angle = if effective_sweep >= 0.0 {
                start_angle + angle_step * i as f64
            } else {
                start_angle - angle_step * i as f64
            };

            let x = *radius * angle.cos();
            let y = *radius * angle.sin();

            points.push(Point2::new(x, y));
        }

        // Ensure exact closure for full circles
        if is_full_circle {
            points[steps - 1] = points[0];
        }

        points
    }
}

#[derive(Debug, Clone)]
pub struct PolygonGeometry {
    pub relative_vertices: Vec<Point2<f64>>, // Relative to center
    pub is_convex: bool,
}

#[derive(Debug)]
pub struct GerberPolygon {
    pub(crate) center: Point2<f64>,
    /// Relative to center
    pub(crate) vertices: Vec<Point2<f64>>,
    pub(crate) exposure: Exposure,
}

impl GerberPolygon {
    /// Checks if a polygon is convex by verifying that all cross products
    /// between consecutive edges have the same sign
    pub fn is_convex(&self) -> bool {
        geometry::is_convex(&self.vertices)
    }
}

impl GerberPrimitive {
    pub(crate) fn new_polygon(polygon: GerberPolygon) -> Self {
        trace!("new_polygon: {:?}", polygon);
        let is_convex = polygon.is_convex();
        let mut relative_vertices = polygon.vertices;

        // Calculate and fix winding order
        let winding = Winding::from_vertices(&relative_vertices);
        if matches!(winding, Winding::Clockwise) {
            relative_vertices.reverse();
        }

        // Deduplicate adjacent vertices with geometric tolerance
        let epsilon = 1e-6; // 1 nanometer in mm units
        let relative_vertices = relative_vertices.dedup_with_epsilon(epsilon);

        let polygon = GerberPrimitive::Polygon(PolygonGerberPrimitive {
            center: polygon.center,
            exposure: polygon.exposure,
            geometry: Arc::new(PolygonGeometry {
                relative_vertices,
                is_convex,
            }),
        });

        trace!("polygon: {:?}", polygon);

        polygon
    }
}

#[cfg(test)]
mod circle_aperture_tests {
    use std::f64::consts::PI;

    use gerber_types::{
        Aperture, ApertureDefinition, Circle, Command, CoordinateFormat, CoordinateMode,
        CoordinateNumber, Coordinates, DCode, ExtendedCode, FunctionCode, Operation, Unit,
        ZeroOmission,
    };
    use nalgebra::Point2;

    use crate::viewer::layer::ArcGerberPrimitive;
    use crate::viewer::layer::{GerberLayer, GerberPrimitive};
    use crate::viewer::testing::dump_gerber_source;
    use crate::viewer::types::Exposure;

    #[test]
    fn test_circle_with_hole_rendering() {
        // Given: A circle aperture with a hole
        let outer_diameter = 2.5;
        let hole_diameter = 0.5;
        let center = Point2::new(0.0_f64, 0.0_f64);

        // Create an aperture definition that would be parsed from the Gerber file
        let aperture = Aperture::Circle(Circle {
            diameter: outer_diameter,
            hole_diameter: Some(hole_diameter),
        });

        let format = CoordinateFormat::new(ZeroOmission::Leading, CoordinateMode::Absolute, 2, 4);

        // Create commands that would define and use this aperture
        let commands = vec![
            // Set unit to millimeters
            Command::ExtendedCode(ExtendedCode::Unit(Unit::Millimeters)),
            Command::ExtendedCode(ExtendedCode::ApertureDefinition(ApertureDefinition::new(
                11, aperture,
            ))),
            Command::FunctionCode(FunctionCode::DCode(DCode::SelectAperture(11))),
            Command::FunctionCode(FunctionCode::DCode(DCode::Operation(Operation::Flash(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(center.x).unwrap(),
                    CoordinateNumber::try_from(center.y).unwrap(),
                    format,
                )),
            )))),
        ];

        // and
        dump_gerber_source(&commands);

        // When
        let layer = GerberLayer::new(commands);
        let primitives = layer.primitives();

        // Then
        assert_eq!(primitives.len(), 1);

        match &primitives[0] {
            GerberPrimitive::Arc(ArcGerberPrimitive {
                center: c,
                radius,
                width,
                start_angle,
                sweep_angle,
                exposure,
            }) => {
                assert_eq!(*c, center);

                // For correct rendering with StrokeKind::Middle
                // The radius should be midway between outer and inner radius
                let expected_radius = (outer_diameter / 2.0 + hole_diameter / 2.0) / 2.0;

                assert!(
                    (radius - expected_radius).abs() < f64::EPSILON,
                    "Radius should be midway between outer and inner radii ({}), got {}",
                    expected_radius,
                    radius
                );

                // Width should be the difference between outer and inner radius
                let expected_width = outer_diameter / 2.0 - hole_diameter / 2.0;
                assert!(
                    (width - expected_width).abs() < f64::EPSILON,
                    "Width should equal the difference between outer and inner radii ({}), got {}",
                    expected_width,
                    width
                );

                assert_eq!(*start_angle, 0.0);
                assert!(
                    (sweep_angle.abs() - 2.0 * PI).abs() < f64::EPSILON,
                    "Sweep angle should be 2π radians (full circle)"
                );
                assert_eq!(*exposure, Exposure::Add);
            }
            _ => panic!("Expected an Arc primitive for circle with hole"),
        }
    }
}
