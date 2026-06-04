use log::{trace, warn};
use nalgebra::{Point2, Vector2};

use crate::viewer::layer::primitive::{GerberPolygon, GerberPrimitive};
use crate::viewer::types::Exposure;

pub(crate) enum RegionError {
    InsufficientVertices,
}

pub(crate) struct Region {
    vertices: Vec<Point2<f64>>,
    start_index: usize,
}

impl Region {
    pub(crate) fn is_empty(&self) -> bool {
        self.vertices.is_empty()
    }
}

impl Region {
    pub(crate) fn new(start_index: usize) -> Self {
        Self {
            vertices: Vec::new(),
            start_index,
        }
    }

    pub(crate) fn push(&mut self, point: Point2<f64>) {
        self.vertices.push(point);
    }

    pub(crate) fn finalize(mut self, end_index: usize) -> Result<GerberPrimitive, RegionError> {
        // SPEC-ISSUE: closed-vs-unclosed-regions - EasyEDA v6.5.48 does not close regions properly
        if self.vertices.len() >= 2 {
            let first = self.vertices.first().unwrap();
            let last = self.vertices.last().unwrap();
            if first != last {
                warn!(
                    "Unclosed region detected. start_index: {}, end_index: {}, first: {}, last: {}",
                    self.start_index, end_index, first, last
                );
            } else {
                // `GerberPolygon` expects an un-closed polygon vertices, so REMOVE the last coordinate from the vertices
                self.vertices.pop();
            }
        }

        trace!("current_region_vertices: {:?}", self.vertices);

        if self.vertices.len() < 3 {
            return Err(RegionError::InsufficientVertices);
        }

        // Find bounding box
        let min_x = self
            .vertices
            .iter()
            .map(|position| position.x)
            .fold(f64::INFINITY, f64::min);
        let max_x = self
            .vertices
            .iter()
            .map(|position| position.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = self
            .vertices
            .iter()
            .map(|position| position.y)
            .fold(f64::INFINITY, f64::min);
        let max_y = self
            .vertices
            .iter()
            .map(|position| position.y)
            .fold(f64::NEG_INFINITY, f64::max);

        // Calculate center from bounding box
        let center_x = (min_x + max_x) / 2.0;
        let center_y = (min_y + max_y) / 2.0;

        let center = Vector2::new(center_x, center_y);

        // Make vertices relative to center
        let relative_vertices: Vec<Point2<f64>> = self
            .vertices
            .iter()
            .map(|position| *position - center)
            .collect();

        let polygon = GerberPrimitive::new_polygon(GerberPolygon {
            center: Point2::new(center_x, center_y),
            vertices: relative_vertices,
            exposure: Exposure::Add,
        });

        Ok(polygon)
    }
}
