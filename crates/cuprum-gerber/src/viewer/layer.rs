use gerber_types::Command;

use crate::viewer::geometry::BoundingBox;

mod bbox;
mod build;
mod primitive;

pub use primitive::GerberPrimitive;

// NOTE: the deprecated image-transform commands MI, SF, OF, IR and AS (mirror,
// scale, offset, rotation, axis-select) are intentionally NOT supported. They are
// obsolete in the Gerber spec and not emitted by modern CAD tools, and an
// anisotropic scale (SFA != SFB) cannot be represented in this primitive model
// (it would turn circles/arcs into ellipses). Such commands are ignored.

/// FUTURE if the rendering is always real-time, then caching the points at the time the primitives are created would have
///        a performance benefit. e.g. `GerberArcPrimitive::generate_points` and similar methods.

#[derive(Clone, Debug)]
pub struct GerberLayer {
    /// Storing the commands, soon we'll want to tag the primitives with the `Command` used to build them.
    #[allow(unused)]
    commands: Vec<Command>,
    gerber_primitives: Vec<GerberPrimitive>,
    bounding_box: BoundingBox,
}

impl GerberLayer {
    pub fn new(commands: Vec<Command>) -> Self {
        let gerber_primitives = GerberLayer::build_primitives(&commands);
        let bounding_box = GerberLayer::calculate_bounding_box(&gerber_primitives);

        Self {
            commands,
            gerber_primitives,
            bounding_box,
        }
    }

    /// It's possible to have a gerber file with no primitives
    pub fn is_empty(&self) -> bool {
        self.bounding_box.is_empty()
    }

    pub fn bounding_box(&self) -> &BoundingBox {
        &self.bounding_box
    }

    /// Return the bounding box if the gerber file resulted in primitives which need drawing.
    pub fn try_bounding_box(&self) -> Option<&BoundingBox> {
        match self.is_empty() {
            true => None,
            false => Some(&self.bounding_box),
        }
    }

    pub fn primitives(&self) -> &[GerberPrimitive] {
        &self.gerber_primitives
    }
}
