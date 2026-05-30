import * as THREE from "three";

/** A single triangulated layer mesh from the Rust core. `kind`: 0 copper,
 *  1 mask, 2 silk, 3 other, 4 barrel (plated bore wall). */
export interface BoardLayerMesh {
  key: string;
  kind: number;
  geometry: THREE.BufferGeometry;
}

/** The fully-triangulated board, ready to render. All heavy work (booleans,
 *  triangulation, drilling) happened in Rust; here we only wrap typed-array
 *  views in BufferGeometry — zero CPU on the main thread. */
export interface BoardMeshData {
  substrate: THREE.BufferGeometry;
  layers: BoardLayerMesh[];
  center: [number, number, number];
  radius: number;
}

interface SectHdr {
  posOff: number;
  posLen: number;
  normOff: number;
  idxOff: number;
  idxLen: number;
}
interface LayerHdr {
  key: string;
  kind: number;
  sect: SectHdr;
}
interface MeshHdr {
  substrate: SectHdr;
  layers: LayerHdr[];
}

/** Wrap one section's bytes as a non-copying BufferGeometry. Float32/Uint32
 *  views alias the original ArrayBuffer (offsets are 4-byte aligned by the
 *  packer), so this is effectively free. */
function buildGeometry(buf: ArrayBuffer, dataStart: number, s: SectHdr): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  if (s.posLen > 0) {
    const positions = new Float32Array(buf, dataStart + s.posOff, s.posLen);
    const normals = new Float32Array(buf, dataStart + s.normOff, s.posLen);
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  }
  if (s.idxLen > 0) {
    const indices = new Uint32Array(buf, dataStart + s.idxOff, s.idxLen);
    g.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  return g;
}

/** Parse the Rust board-mesh blob:
 *  `[u32 headerLen][header JSON][pad to 4][data: f32/u32 sections]`. */
export function parseBoardMesh(buf: ArrayBuffer): BoardMeshData {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buf, 4, headerLen);
  const header: MeshHdr = JSON.parse(new TextDecoder().decode(headerBytes));
  const dataStart = Math.ceil((4 + headerLen) / 4) * 4;

  const substrate = buildGeometry(buf, dataStart, header.substrate);
  const layers: BoardLayerMesh[] = header.layers.map((l) => ({
    key: l.key,
    kind: l.kind,
    geometry: buildGeometry(buf, dataStart, l.sect),
  }));

  // Centre + radius from the overall bounds (substrate first; fall back to the
  // layer meshes if there's no board outline).
  const box = new THREE.Box3();
  substrate.computeBoundingBox();
  if (substrate.boundingBox && isFinite(substrate.boundingBox.min.x)) {
    box.union(substrate.boundingBox);
  } else {
    for (const l of layers) {
      l.geometry.computeBoundingBox();
      if (l.geometry.boundingBox && isFinite(l.geometry.boundingBox.min.x)) {
        box.union(l.geometry.boundingBox);
      }
    }
  }
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  if (!box.isEmpty()) {
    box.getCenter(center);
    box.getSize(size);
  }
  const radius = size.length() / 2 || 50;

  return { substrate, layers, center: [center.x, center.y, center.z], radius };
}
