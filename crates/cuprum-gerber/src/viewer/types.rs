use nalgebra::Point2;

pub(crate) enum Winding {
    /// Negative shoelace area in the Y-up gerber coordinate system.
    Clockwise,
    /// Positive shoelace area in the Y-up gerber coordinate system.
    CounterClockwise,
}

impl Winding {
    /// Shoelace sign convention matches `geometry::tess::signed_area`:
    /// positive sum = counter-clockwise (Y-up).
    pub(crate) fn from_vertices(vertices: &[Point2<f64>]) -> Self {
        let mut sum = 0.0;
        for i in 0..vertices.len() {
            let j = (i + 1) % vertices.len();
            sum += vertices[i].x * vertices[j].y - vertices[j].x * vertices[i].y;
        }
        if sum > 0.0 {
            Winding::CounterClockwise
        } else {
            Winding::Clockwise
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exposure {
    CutOut,
    Add,
}

impl From<bool> for Exposure {
    fn from(value: bool) -> Self {
        match value {
            true => Exposure::Add,
            false => Exposure::CutOut,
        }
    }
}

#[cfg(test)]
mod tests {
    use nalgebra::Point2;

    use super::Winding;

    #[test]
    fn ccw_square_is_counter_clockwise() {
        // Counter-clockwise in the Y-up gerber coordinate system.
        let vertices = [
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ];
        assert!(matches!(
            Winding::from_vertices(&vertices),
            Winding::CounterClockwise
        ));
    }

    #[test]
    fn cw_square_is_clockwise() {
        let vertices = [
            Point2::new(0.0, 1.0),
            Point2::new(1.0, 1.0),
            Point2::new(1.0, 0.0),
            Point2::new(0.0, 0.0),
        ];
        assert!(matches!(
            Winding::from_vertices(&vertices),
            Winding::Clockwise
        ));
    }
}
