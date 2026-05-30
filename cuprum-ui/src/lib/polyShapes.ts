import * as THREE from "three";
import polygonClipping, { type Pair, type Polygon, type Ring, type MultiPolygon } from "polygon-clipping";

// Robust 2D boolean ops on THREE.Shapes so we feed the triangulator SIMPLE,
// non-overlapping polygons. earcut mis-triangulates overlapping/self-intersecting
// input (covers holes, emits slivers); resolving overlaps first (union/difference)
// fixes the artifacts at the source instead of dropping triangles afterwards.

const CURVE_DIV = 24;

function ringOf(curve: THREE.Curve<THREE.Vector2>): Ring {
  const pts = curve.getPoints(CURVE_DIV).map((p) => [p.x, p.y] as Pair);
  if (pts.length === 0) return pts as Ring;
  const a = pts[0], b = pts[pts.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]); // close the ring
  return pts as Ring;
}

/** THREE.Shape (outer + holes) → polygon-clipping Polygon. */
function shapeToPolygon(shape: THREE.Shape): Polygon {
  return [ringOf(shape), ...shape.holes.map((h) => ringOf(h))];
}

/** polygon-clipping MultiPolygon → THREE.Shapes (outer ring + hole rings). */
function multiPolygonToShapes(mp: MultiPolygon): THREE.Shape[] {
  const toV = (ring: Ring) => ring.map(([x, y]) => new THREE.Vector2(x, y));
  return mp
    .filter((poly) => poly.length > 0 && poly[0].length >= 4)
    .map((poly) => {
      const shape = new THREE.Shape(toV(poly[0]));
      for (let i = 1; i < poly.length; i++) shape.holes.push(new THREE.Path(toV(poly[i])));
      return shape;
    });
}

/** `base` minus every shape in `cuts`, returned as clean (non-overlapping) shapes. */
export function subtractShapes(base: THREE.Shape, cuts: THREE.Shape[]): THREE.Shape[] {
  const basePoly: Polygon = shapeToPolygon(base);
  if (cuts.length === 0) return multiPolygonToShapes([basePoly]);
  const cutMp: MultiPolygon = cuts.map((c) => shapeToPolygon(c));
  const result = polygonClipping.difference([basePoly], cutMp);
  return multiPolygonToShapes(result);
}

/** Union of many shapes into clean (non-overlapping) shapes. */
export function unionShapes(shapes: THREE.Shape[]): THREE.Shape[] {
  if (shapes.length === 0) return [];
  const polys = shapes.map((s) => shapeToPolygon(s));
  const result = polygonClipping.union([polys[0]], ...polys.slice(1).map((p) => [p] as MultiPolygon));
  return multiPolygonToShapes(result);
}

/** `bases` (already a clean region) minus every shape in `cuts`. */
export function differenceShapes(bases: THREE.Shape[], cuts: THREE.Shape[]): THREE.Shape[] {
  if (bases.length === 0) return [];
  const baseMp: MultiPolygon = bases.map((b) => shapeToPolygon(b));
  if (cuts.length === 0) return multiPolygonToShapes(baseMp);
  const cutMp: MultiPolygon = cuts.map((c) => shapeToPolygon(c));
  const result = polygonClipping.difference(baseMp, cutMp);
  return multiPolygonToShapes(result);
}
