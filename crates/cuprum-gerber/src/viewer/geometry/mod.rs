mod bounding_box;
mod shapes;

pub use bounding_box::BoundingBox;
pub use shapes::is_convex;

use gerber_types::{AxisSelect, ImageMirroring};
use nalgebra::{Matrix3, Vector2};

/// This is to support the deprecated MI, SF, OF, IR and AS commands.
///
/// Transform order, as per spec, is: MI, SF, OF, IR and AS.
/// aka Mirroring, Scaling, Offset, Rotation and Axis Select.
///
/// Rotation is always around the origin, 0,0
#[derive(Clone, Debug)]
pub struct GerberImageTransform {
    /// A = X, B = Y.
    pub mirroring: ImageMirroring,
    pub offset: Vector2<f64>,
    pub scale: Vector2<f64>,
    /// rotation in radians, positive = counter-clockwise
    pub rotation: f64,
    pub axis_select: AxisSelect,
}

impl Default for GerberImageTransform {
    fn default() -> Self {
        Self {
            mirroring: ImageMirroring::default(),
            offset: Vector2::new(0.0, 0.0),
            scale: Vector2::new(1.0, 1.0),
            rotation: 0.0,
            axis_select: AxisSelect::default(),
        }
    }
}

impl GerberImageTransform {
    /// Converts this transform to a 3x3 homogeneous transformation matrix
    #[rustfmt::skip]
    pub fn to_matrix(&self) -> Matrix3<f64> {

        let [mirror_x, mirror_y] = match self.mirroring {
            ImageMirroring::None => [1.0, 1.0],
            ImageMirroring::A => [-1.0, 1.0],
            ImageMirroring::B => [1.0, -1.0],
            ImageMirroring::AB => [-1.0, -1.0],
        };
        let mirroring_matrix = Matrix3::new(
            mirror_x, 0.0, 0.0,
            0.0, mirror_y, 0.0,
            0.0, 0.0, 1.0
        );

        let scaling_matrix = Matrix3::new(
            self.scale.x, 0.0, 0.0,
            0.0, self.scale.y, 0.0,
            0.0, 0.0, 1.0
        );

        let rad = self.rotation;
        let cos_rad = rad.cos();
        let sin_rad = rad.sin();
        let rotation_matrix = Matrix3::new(
            cos_rad, -sin_rad, 0.0,
            sin_rad, cos_rad, 0.0,
            0.0, 0.0, 1.0
        );

        let translate_offset = Matrix3::new(
            1.0, 0.0, self.offset.x,
            0.0, 1.0, self.offset.y,
            0.0, 0.0, 1.0
        );

        let axis_assignment_matrix = match self.axis_select {
            AxisSelect::AXBY => Matrix3::identity(),
            AxisSelect::AYBX => Matrix3::new(
                0.0, 1.0, 0.0,  // First row
                1.0, 0.0, 0.0,  // Second row
                0.0, 0.0, 1.0,  // Homogeneous row
            ),
        };

        mirroring_matrix * scaling_matrix * translate_offset * rotation_matrix * axis_assignment_matrix
    }
}
