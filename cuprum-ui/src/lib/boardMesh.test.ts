import { describe, it, expect } from "vitest";
import { parseBoardMesh } from "@/lib/boardMesh";

// Build the wire blob `[u32 headerLen][header JSON][pad to 4][f32/u32 data]` by
// hand: a substrate triangle + one copper layer triangle. Section offsets are
// byte offsets within the data region; *Len fields are element counts.
function buildBlob(): ArrayBuffer {
  const subPos = [0, 0, 0, 2, 0, 0, 0, 2, 0];
  const subNorm = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const subIdx = [0, 1, 2];
  const layPos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const layNorm = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const layIdx = [0, 1, 2];

  const header = {
    substrate: { posOff: 0, posLen: 9, normOff: 36, idxOff: 72, idxLen: 3 },
    layers: [
      { key: "topCopper", kind: 0, sect: { posOff: 84, posLen: 9, normOff: 120, idxOff: 156, idxLen: 3 } },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerLen = json.length;
  const dataStart = Math.ceil((4 + headerLen) / 4) * 4;
  const dataLen = 168;
  const buf = new ArrayBuffer(dataStart + dataLen);

  new DataView(buf).setUint32(0, headerLen, true);
  new Uint8Array(buf, 4, headerLen).set(json);

  const f = new Float32Array(buf, dataStart);
  const u = new Uint32Array(buf, dataStart);
  const setF = (byteOff: number, arr: number[]) => f.set(arr, byteOff / 4);
  const setU = (byteOff: number, arr: number[]) => u.set(arr, byteOff / 4);
  setF(0, subPos);
  setF(36, subNorm);
  setU(72, subIdx);
  setF(84, layPos);
  setF(120, layNorm);
  setU(156, layIdx);
  return buf;
}

describe("parseBoardMesh", () => {
  it("decodes substrate and layer sections from the wire format", () => {
    const mesh = parseBoardMesh(buildBlob());

    const subPos = mesh.substrate.getAttribute("position");
    expect(subPos.count).toBe(3);
    expect(Array.from(subPos.array)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(Array.from(mesh.substrate.getIndex()!.array)).toEqual([0, 1, 2]);

    expect(mesh.layers).toHaveLength(1);
    expect(mesh.layers[0].key).toBe("topCopper");
    expect(mesh.layers[0].kind).toBe(0);
    expect(Array.from(mesh.layers[0].geometry.getAttribute("position").array)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
  });

  it("computes center and radius from the substrate bounds", () => {
    const mesh = parseBoardMesh(buildBlob());
    expect(mesh.center[0]).toBeCloseTo(1, 6);
    expect(mesh.center[1]).toBeCloseTo(1, 6);
    expect(mesh.center[2]).toBeCloseTo(0, 6);
    expect(mesh.radius).toBeCloseTo(Math.sqrt(8) / 2, 6);
  });
});
