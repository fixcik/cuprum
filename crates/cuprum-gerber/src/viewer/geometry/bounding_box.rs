use nalgebra::Point2;

#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub struct BoundingBox {
    pub min: Point2<f64>,
    pub max: Point2<f64>,
}

impl BoundingBox {
    pub fn expand(&mut self, other: &BoundingBox) {
        self.min.x = self.min.x.min(other.min.x);
        self.min.y = self.min.y.min(other.min.y);
        self.max.x = self.max.x.max(other.max.x);
        self.max.y = self.max.y.max(other.max.y);
    }
}

impl Default for BoundingBox {
    fn default() -> Self {
        Self {
            min: Point2::new(f64::MAX, f64::MAX),
            max: Point2::new(f64::MIN, f64::MIN),
        }
    }
}

impl BoundingBox {
    /// Note that a bounding box of 0,0 -> 0,0 is NOT empty
    /// e.g., you could have a shape that defines a rectangle with an origin of 0,0 and a width + height of 0,0.
    ///
    /// Only a bounding box which is the same as the one returned by `default` counts as empty.
    pub fn is_empty(&self) -> bool {
        self.eq(&BoundingBox::default())
    }

    pub fn width(&self) -> f64 {
        self.max.x - self.min.x
    }
    pub fn height(&self) -> f64 {
        self.max.y - self.min.y
    }

    /// Returns the geometric center of the bounding box as a Point2
    pub fn center(&self) -> Point2<f64> {
        Point2::new(self.min.x + self.max.x, self.min.y + self.max.y) / 2.0
    }

    /// Returns 4 corner points of the bounding box such that the result is useable as a closed path.
    /// ```plaintext
    /// (min_x, min_y) 1 ┌────────────┐ 2 (max_x, min_y)
    ///                  │            │
    /// (min_x, max_y) 4 └────────────┘ 3 (max_x, max_y)
    /// ```
    pub fn vertices(&self) -> Vec<Point2<f64>> {
        vec![
            Point2::new(self.min.x, self.min.y),
            Point2::new(self.max.x, self.min.y),
            Point2::new(self.max.x, self.max.y),
            Point2::new(self.min.x, self.max.y),
        ]
    }

    /// Constructs a bounding box from a list of points
    pub fn from_points(points: &[Point2<f64>]) -> Self {
        let mut min = Point2::new(f64::MAX, f64::MAX);
        let mut max = Point2::new(f64::MIN, f64::MIN);

        for position in points {
            min.x = min.x.min(position.x);
            min.y = min.y.min(position.y);
            max.x = max.x.max(position.x);
            max.y = max.y.max(position.y);
        }

        Self { min, max }
    }
}

#[cfg(test)]
mod bbox_tests {
    use nalgebra::Point2;
    use rstest::rstest;

    use crate::viewer::geometry::bounding_box::BoundingBox;

    #[rstest]
    #[case(BoundingBox::default(), true)]
    #[case(BoundingBox { min: Point2::new(0.0, 0.0), max: Point2::new(0.0, 0.0) }, false)]
    #[case(BoundingBox { min: Point2::new(-10.0, -10.0), max: Point2::new(10.0, 10.0) }, false)]
    pub fn test_is_empty(#[case] input: BoundingBox, #[case] expected: bool) {
        assert_eq!(input.is_empty(), expected);
    }

    #[rstest]
    #[case((0.0, 0.0), (10.0, 10.0), (5.0, 5.0))] // Case 1: Origin 0, 10x10
    #[case((10.0, 10.0), (10.0, 10.0), (15.0, 15.0))] // Case 2: Origin 10, 10x10
    #[case((0.0, 0.0), (5.0, 10.0), (2.5, 5.0))] // Case 3: Origin 0, 5x10
    #[case((0.0, 0.0), (10.0, 5.0), (5.0, 2.5))] // Case 4: Origin 0, 10x5
    #[case((10.0, 10.0), (5.0, 10.0), (12.5, 15.0))] // Case 5: Origin 10, 5x10
    #[case((10.0, 10.0), (10.0, 5.0), (15.0, 12.5))] // Case 6: Origin 10, 10x5
    fn test_geometric_center(
        #[case] origin: (f64, f64),
        #[case] size: (f64, f64),
        #[case] expected: (f64, f64),
    ) {
        // Create bounding box from origin and size
        let bbox = BoundingBox {
            min: Point2::new(origin.0, origin.1),
            max: Point2::new(origin.0 + size.0, origin.1 + size.1),
        };

        let center = bbox.center();

        // Compare with precision to handle floating-point numbers
        let epsilon = 1e-9;
        assert!(
            (center.x - expected.0).abs() < epsilon,
            "X mismatch: expected {}, got {}",
            expected.0,
            center.x
        );
        assert!(
            (center.y - expected.1).abs() < epsilon,
            "Y mismatch: expected {}, got {}",
            expected.1,
            center.y
        );
    }
}
