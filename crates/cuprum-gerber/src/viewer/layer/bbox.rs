use std::ops::Add;

use nalgebra::{Point2, Vector2};

use super::primitive::{
    ArcGerberPrimitive, CircleGerberPrimitive, LineGerberPrimitive, PolygonGerberPrimitive,
    RectangleGerberPrimitive,
};
use crate::viewer::geometry::BoundingBox;
use crate::viewer::spacial::ToVector;

pub trait WithBoundingBox {
    fn bounding_box(&self) -> BoundingBox;
}

impl WithBoundingBox for CircleGerberPrimitive {
    fn bounding_box(&self) -> BoundingBox {
        let Self {
            center, diameter, ..
        } = self;
        let radius = diameter / 2.0;
        BoundingBox {
            min: Point2::new(center.x - radius, center.y - radius),
            max: Point2::new(center.x + radius, center.y + radius),
        }
    }
}

impl WithBoundingBox for ArcGerberPrimitive {
    fn bounding_box(&self) -> BoundingBox {
        let Self { center, width, .. } = self;
        let half_width = width / 2.0;

        let points = self.generate_points();
        let mut bbox = BoundingBox::default();

        for point in points {
            // TODO this could be improved by using a tangent of the arc at each point and
            //      using a vector, of length `half_width`, pointing away from the arc origin, to calculate the
            //      real outer point.

            let center_point = center + point.to_vector();
            let (x, y) = (center_point.x, center_point.y);
            // Use an axis aligned SQUARE of the stroke width at the point to calculate the bounding box
            // For now this approximation is sufficient for current purposes.
            let stroke_bbox = BoundingBox {
                min: Point2::new(x - half_width, y - half_width),
                max: Point2::new(x + half_width, y + half_width),
            };

            // Update bounding box using the stroke bbox
            bbox.expand(&stroke_bbox);
        }

        bbox
    }
}

impl WithBoundingBox for RectangleGerberPrimitive {
    fn bounding_box(&self) -> BoundingBox {
        let Self {
            origin,
            width,
            height,
            ..
        } = self;
        BoundingBox {
            min: Point2::new(origin.x, origin.y),
            max: Point2::new(origin.x + width, origin.y + height),
        }
    }
}

impl WithBoundingBox for LineGerberPrimitive {
    fn bounding_box(&self) -> BoundingBox {
        let Self {
            start, end, width, ..
        } = self;

        let radius = width / 2.0;
        let mut bbox = BoundingBox {
            min: Point2::new(start.x - radius, start.y - radius),
            max: Point2::new(start.x + radius, start.y + radius),
        };
        let end_bbox = BoundingBox {
            min: Point2::new(end.x - radius, end.y - radius),
            max: Point2::new(end.x + radius, end.y + radius),
        };
        bbox.expand(&end_bbox);

        bbox
    }
}

impl WithBoundingBox for PolygonGerberPrimitive {
    fn bounding_box(&self) -> BoundingBox {
        let Self {
            center, geometry, ..
        } = self;

        let center: Vector2<f64> = center.coords;

        let points = geometry
            .relative_vertices
            .iter()
            .map(|position| position.add(center))
            .collect::<Vec<_>>();

        BoundingBox::from_points(&points)
    }
}

#[cfg(test)]
mod bounding_box_arc_tests {
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

    use nalgebra::Point2;
    use rstest::rstest;

    use super::WithBoundingBox;
    use crate::viewer::geometry::BoundingBox;
    use crate::viewer::layer::{ArcGerberPrimitive, GerberLayer, GerberPrimitive};
    use crate::viewer::types::Exposure;

    // Helper function to create a test arc
    fn create_arc_primitive(
        center_x: f64,
        center_y: f64,
        radius: f64,
        width: f64,
        start_angle: f64,
        sweep_angle: f64,
    ) -> GerberPrimitive {
        GerberPrimitive::Arc(ArcGerberPrimitive {
            center: Point2::new(center_x, center_y),
            radius,
            width,
            start_angle,
            sweep_angle,
            exposure: Exposure::Add,
        })
    }

    // This test is more result-orientated, requires no use of sin/cos/tan/PI/etc.
    #[test]
    pub fn test_full_circle() {
        // given
        let arc_primitive = ArcGerberPrimitive {
            center: Default::default(),
            radius: 100.0,
            width: 1.0,
            start_angle: 0.0_f64.to_radians(),
            sweep_angle: 0.0_f64.to_radians(),
            exposure: Exposure::Add,
        };

        // when
        let bbox = arc_primitive.bounding_box();

        // then
        println!("bbox: {:?}", bbox);
        // should be the same with as the diameter of the circle + half of the stroke width.
        assert_eq!(bbox.min, Point2::new(-100.5, -100.5));
        assert_eq!(bbox.max, Point2::new(100.5, 100.5));
    }

    // Test for full circles (behavior orientated)
    #[rstest]
    #[case(0.0, 0.0, 100.0, 0.0, 0.0)] // start = 0, sweep = 0 (special case for full circle)
    #[case(0.0, 0.0, 100.0, 0.0, 2.0 * PI)] // start = 0, sweep = 2π
    #[case(10.0, 5.0, 100.0, 0.0, 0.0)] // start = 0, sweep = 0 (special case for full circle)
    #[case(10.0, 5.0, 100.0, 0.0, 2.0 * PI)] // start = 0, sweep = 2π
    fn test_full_circle_bounds(
        #[case] center_y: f64,
        #[case] center_x: f64,
        #[case] radius: f64,
        #[case] start_angle: f64,
        #[case] sweep_angle: f64,
    ) {
        // Setup

        let width = 0.5;

        let arc = create_arc_primitive(center_x, center_y, radius, width, start_angle, sweep_angle);
        let primitives = vec![arc];

        let bbox = GerberLayer::calculate_bounding_box(&primitives);

        // For a full circle, the bounds should be center +/- (radius + half_width)
        let half_width = width / 2.0;

        // Verify the bounding box is approximately correct
        assert!(
            (bbox.min.x - (center_x - radius - half_width)).abs() < 1.0,
            "min.x should be approximately {}, got {}",
            center_x - radius - half_width,
            bbox.min.x
        );
        assert!(
            (bbox.min.y - (center_y - radius - half_width)).abs() < 1.0,
            "min.y should be approximately {}, got {}",
            center_y - radius - half_width,
            bbox.min.y
        );
        assert!(
            (bbox.max.x - (center_x + radius + half_width)).abs() < 1.0,
            "max.x should be approximately {}, got {}",
            center_x + radius + half_width,
            bbox.max.x
        );
        assert!(
            (bbox.max.y - (center_y + radius + half_width)).abs() < 1.0,
            "max.y should be approximately {}, got {}",
            center_y + radius + half_width,
            bbox.max.y
        );
    }

    // bbox should be the same as the stroke width, centered on the center
    #[rstest]
    #[case(0.0, 0.0, BoundingBox { min: Point2::new(-0.5, -0.5), max: Point2::new(0.5, 0.5)})]
    #[case(10.0, 10.0, BoundingBox { min: Point2::new(9.5, 9.5), max: Point2::new(10.5, 10.5)})]
    pub fn test_full_circle_zero_radius(
        #[case] center_y: f64,
        #[case] center_x: f64,
        #[case] expected_bbox: BoundingBox,
    ) {
        // given
        let arc_primitive = ArcGerberPrimitive {
            center: Point2::new(center_x, center_y),
            radius: 0.0,
            width: 1.0,
            start_angle: 0.0_f64.to_radians(),
            sweep_angle: 0.0_f64.to_radians(),
            exposure: Exposure::Add,
        };

        // when
        let bbox = arc_primitive.bounding_box();

        // then
        println!("bbox: {:?}, expected: {:?}", bbox, expected_bbox);
        assert_eq!(bbox.min, expected_bbox.min);
        assert_eq!(bbox.max, expected_bbox.max);
    }

    // Test for partial arcs
    #[rstest]
    #[case(0.0, FRAC_PI_2)] // 0° to 90°
    #[case(FRAC_PI_2, FRAC_PI_2)] // 90° to 180°
    #[case(PI, FRAC_PI_2)] // 180° to 270°
    #[case(PI + FRAC_PI_2, FRAC_PI_2)] // 270° to 360°
    fn test_quarter_arc_bounds(#[case] start_angle: f64, #[case] sweep_angle: f64) {
        // Setup
        let center_x = 5.0;
        let center_y = 5.0;
        let radius = 10.0;
        let width = 0.5;

        let arc = create_arc_primitive(center_x, center_y, radius, width, start_angle, sweep_angle);
        let primitives = vec![arc];

        // Execute
        let bbox = GerberLayer::calculate_bounding_box(&primitives);

        // Verify the bounding box contains the center point plus the arc
        let half_width = width / 2.0;
        let total_radius = radius + half_width;

        // The bounds shouldn't exceed center +/- (radius + half_width) in any direction
        assert!(bbox.min.x >= center_x - total_radius - 0.1);
        assert!(bbox.min.y >= center_y - total_radius - 0.1);
        assert!(bbox.max.x <= center_x + total_radius + 0.1);
        assert!(bbox.max.y <= center_y + total_radius + 0.1);

        // Verify the bounds contain the start and end points of the arc
        let start_x = center_x + radius * start_angle.cos();
        let start_y = center_y + radius * start_angle.sin();
        let end_x = center_x + radius * (start_angle + sweep_angle).cos();
        let end_y = center_y + radius * (start_angle + sweep_angle).sin();

        assert!(bbox.min.x <= start_x + 0.1);
        assert!(bbox.min.y <= start_y + 0.1);
        assert!(bbox.max.x >= start_x - 0.1);
        assert!(bbox.max.y >= start_y - 0.1);

        assert!(bbox.min.x <= end_x + 0.1);
        assert!(bbox.min.y <= end_y + 0.1);
        assert!(bbox.max.x >= end_x - 0.1);
        assert!(bbox.max.y >= end_y - 0.1);

        // The bounds should contain the center point, but only because they would naturally
        assert!(bbox.min.x <= center_x);
        assert!(bbox.min.y <= center_y);
        assert!(bbox.max.x >= center_x);
        assert!(bbox.max.y >= center_y);
    }

    // Test for negative sweeps (clockwise arcs)
    #[rstest]
    #[case(FRAC_PI_4, -FRAC_PI_4)] // Small negative sweep
    #[case(FRAC_PI_2, -FRAC_PI_2)] // Quarter negative sweep
    #[case(PI, -PI)] // Half negative sweep
    fn test_negative_sweep_arc_bounds(#[case] start_angle: f64, #[case] sweep_angle: f64) {
        // Setup
        let center_x = 5.0;
        let center_y = 5.0;
        let radius = 10.0;
        let width = 0.5;

        let arc = create_arc_primitive(center_x, center_y, radius, width, start_angle, sweep_angle);
        let primitives = vec![arc];

        // Execute
        let bbox = GerberLayer::calculate_bounding_box(&primitives);

        // Same verification as for positive sweeps
        let half_width = width / 2.0;
        let total_radius = radius + half_width;

        // The bounds shouldn't exceed center +/- (radius + half_width) in any direction
        assert!(bbox.min.x >= center_x - total_radius - 0.1);
        assert!(bbox.min.y >= center_y - total_radius - 0.1);
        assert!(bbox.max.x <= center_x + total_radius + 0.1);
        assert!(bbox.max.y <= center_y + total_radius + 0.1);

        // Verify the bounds contain the start and end points of the arc
        let start_x = center_x + radius * start_angle.cos();
        let start_y = center_y + radius * start_angle.sin();
        let end_x = center_x + radius * (start_angle + sweep_angle).cos();
        let end_y = center_y + radius * (start_angle + sweep_angle).sin();

        assert!(bbox.min.x <= start_x + 0.1);
        assert!(bbox.min.y <= start_y + 0.1);
        assert!(bbox.max.x >= start_x - 0.1);
        assert!(bbox.max.y >= start_y - 0.1);

        assert!(bbox.min.x <= end_x + 0.1);
        assert!(bbox.min.y <= end_y + 0.1);
        assert!(bbox.max.x >= end_x - 0.1);
        assert!(bbox.max.y >= end_y - 0.1);
    }

    // Test with offset center
    #[test]
    fn test_arc_offset_center() {
        // Test with a non-origin center
        let center_x = 15.0;
        let center_y = -10.0;
        let radius = 5.0;
        let width = 0.3;
        let start_angle = 0.0;
        let sweep_angle = FRAC_PI_2; // 90° sweep

        let arc = create_arc_primitive(center_x, center_y, radius, width, start_angle, sweep_angle);
        let primitives = vec![arc];

        let bbox = GerberLayer::calculate_bounding_box(&primitives);

        // Verify the bounds for offset center
        let half_width = width / 2.0;

        // The bounds must include at least the start and end points
        let start_x = center_x + radius * start_angle.cos();
        let start_y = center_y + radius * start_angle.sin();
        let end_x = center_x + radius * (start_angle + sweep_angle).cos();
        let end_y = center_y + radius * (start_angle + sweep_angle).sin();

        assert!(bbox.min.x <= start_x + 0.1);
        assert!(bbox.min.y <= start_y + 0.1);
        assert!(bbox.max.x >= start_x - 0.1);
        assert!(bbox.max.y >= start_y - 0.1);

        assert!(bbox.min.x <= end_x + 0.1);
        assert!(bbox.min.y <= end_y + 0.1);
        assert!(bbox.max.x >= end_x - 0.1);
        assert!(bbox.max.y >= end_y - 0.1);

        // For a 90° arc in the first quadrant, we expect:
        assert!(bbox.min.x >= center_x - half_width - 0.1); // min X should be near center
        assert!(bbox.min.y >= center_y - half_width - 0.1); // min Y should be near center
        assert!(bbox.max.x <= center_x + radius + half_width + 0.1); // max X should extend to right
        assert!(bbox.max.y <= center_y + radius + half_width + 0.1); // max Y should extend upward
    }
}
