import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, GizmoHelper, GizmoViewcube } from "@react-three/drei";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BoardMeshData } from "@/lib/boardMesh";
import { PanelStatus } from "@/components/ui/PanelStatus";

const COPPER_COLOR = "#caa84a"; // ENIG gold finish (matches 2D DEFAULT_LAYER_COLORS)
const MASK_COLOR = "#2e6e40"; // muted matte soldermask green
const SILK_COLOR = "#f5f5f5";
const FR4_COLOR = "#59512c"; // bare fiberglass — dark olive (distinct from copper gold)

// Layer "kind" tags, mirrored from cuprum-core/src/mesh.rs.
const KIND_COPPER = 0;
const KIND_MASK = 1;
const KIND_SILK = 2;
const KIND_BARREL = 4;

/** Procedural image-based lighting. A metallic MeshStandardMaterial shows almost
 *  no diffuse colour — it is visible only through what it reflects, so without an
 *  environment map copper goes black everywhere except the narrow specular hotspot
 *  of a direct light (the highlight "vanishes" the instant you tilt off it). Baking
 *  three's bundled RoomEnvironment into a PMREM cubemap once on mount gives every
 *  standard material a soft room to reflect, so copper stays lit and metallic at any
 *  view angle. RoomEnvironment ships inside three — no network/HDR asset. */
function SceneEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envTex = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envTex;
    return () => {
      scene.environment = null;
      envTex.dispose();
      room.dispose(); // frees the room's box geometry + materials
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** A directional light that tracks the camera — like the viewer holding a lamp. */
function HeadLight({ intensity }: { intensity: number }) {
  const { camera } = useThree();
  const ref = useRef<THREE.DirectionalLight>(null);
  useFrame(() => {
    const light = ref.current;
    if (!light) return;
    light.position.copy(camera.position);
    light.target.position.set(0, 0, 0);
    light.target.updateMatrixWorld();
  });
  return <directionalLight ref={ref} intensity={intensity} />;
}

/** Orthographic scene camera — `zoom` = px per world-unit = px/mm, so the 3D
 *  scale matches the 2D view (best for inspection). Starts on the side the 2D
 *  view was showing and opens at `initialZoom` (the 2D px/mm); OrbitControls owns
 *  the zoom afterwards. */
function SceneCamera({ initialZoom, radius, side }: { initialZoom?: number; radius: number; side: "top" | "bottom" }) {
  const { size } = useThree();
  const ref = useRef<THREE.OrthographicCamera>(null);
  // Place the camera imperatively ONCE, on mount. We deliberately do NOT pass a
  // reactive `position` prop: R3F would re-apply it on every React re-render
  // (e.g. when the side-facing reporter fires mid-animation), teleporting the
  // camera and making SnapFx's 300ms move look instant. After mount, SnapFx +
  // OrbitControls own the camera; IntroFx drives frame 1.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const sign = side === "bottom" ? -1 : 1;
    c.position.set(0, 0, sign * radius * 4);
    const fit = Math.min(size.width, size.height) / Math.max(radius * 2.4, 1);
    c.zoom = initialZoom && initialZoom > 0 ? initialZoom : fit;
    c.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <OrthographicCamera ref={ref} makeDefault near={0.1} far={radius * 8} />;
}

// Intro target tilt: from straight-on, tip the TOP edge toward the viewer ~15°
// and yaw ~15° (left edge swings toward the right). Derived once as a unit dir.
const TILT_DEG = 15;
const YAW_DEG = 15;
const introDir = (() => {
  const t = (TILT_DEG * Math.PI) / 180;
  const y = (YAW_DEG * Math.PI) / 180;
  // straight-on (0,0,1) → Rx(-t) tips +Y edge toward camera → Ry(y) yaws.
  const v = new THREE.Vector3(0, Math.sin(t), Math.cos(t)); // top toward viewer
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), y); // yaw about vertical
  return v.normalize();
})();

/** The default resting view direction for a side. Viewing from below mirrors the
 *  screen X axis, so the top mirrors X to animate the SAME apparent way as the
 *  bottom (the reference). The bottom also looks from -Z. */
function heroDir(side: "top" | "bottom"): THREE.Vector3 {
  const sign = side === "bottom" ? -1 : 1;
  const xSign = side === "bottom" ? 1 : -1;
  return new THREE.Vector3(introDir.x * xSign, introDir.y, introDir.z * sign);
}

/** One-shot intro on entering 3D: from the flat straight-on view (matching the
 *  2D orientation + side) ease into a gentle tilted view (~15° tilt + ~15° yaw)
 *  over ~0.9s. Only the camera position moves (ortho zoom stays → scale
 *  preserved). Runs once per mount (one 2D→3D entry); layer changes keep the
 *  Canvas mounted so it does NOT replay and the camera state is preserved. */
function IntroFx({ radius, side }: { radius: number; side: "top" | "bottom" }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { update?: () => void } | null;
  const startT = useRef<number | null>(null);
  const done = useRef(false);
  const sign = side === "bottom" ? -1 : 1;
  const dist = radius * 4;
  const from = useMemo(() => new THREE.Vector3(0, 0, sign * dist), [dist, sign]);
  const to = useMemo(() => heroDir(side).multiplyScalar(dist), [side, dist]);
  useFrame((state) => {
    if (done.current) return;
    if (startT.current === null) startT.current = state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - startT.current) / 0.9);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    camera.position.lerpVectors(from, to, e);
    camera.lookAt(0, 0, 0);
    controls?.update?.();
    if (t >= 1) done.current = true;
  });
  return null;
}

/** Within ~20° of straight-on counts as viewing that face; tilt past that and the
 *  side selection clears (you're looking at an angle, not at the top/bottom). */
const FACING_COS = 0.94;

/** Report which face the camera is roughly looking at (top/bottom/null) as the
 *  orbit changes, so the side toggle reflects the live view and deselects once
 *  you tilt away. Only fires on a transition (not every frame). */
function FacingReporter({ onChange }: { onChange?: (f: "top" | "bottom" | null) => void }) {
  const camera = useThree((s) => s.camera);
  const last = useRef<"top" | "bottom" | null | undefined>(undefined);
  useFrame(() => {
    if (!onChange) return;
    const len = camera.position.length() || 1;
    const dz = camera.position.z / len;
    const f = dz > FACING_COS ? "top" : dz < -FACING_COS ? "bottom" : null;
    if (f !== last.current) {
      last.current = f;
      onChange(f);
    }
  });
  return null;
}

/** Wrap an angle to (−π, π]. */
function wrapPi(a: number): number {
  const TWO_PI = Math.PI * 2;
  return (((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI - Math.PI;
}

/** Snap the camera straight onto `side` when `snapNonce` bumps (the user clicked
 *  the Top/Bottom toggle). Eased over 300ms. Interpolates the view in SPHERICAL
 *  coords (azimuth around the vertical + elevation) at a constant distance — so
 *  top↔bottom swings around the SIDE (azimuth 0→π at elevation 0) instead of over
 *  a pole (where up∥view glitches) or through the board centre (a position lerp). */
function SnapFx({ side, snapNonce, radius }: { side: "top" | "bottom"; snapNonce: number; radius: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { update?: () => void } | null;
  const prev = useRef(snapNonce);
  const anim = useRef<{ az: number; el: number; dAz: number; dEl: number; dist: number; start: number | null } | null>(null);
  useFrame((state) => {
    if (prev.current !== snapNonce) {
      prev.current = snapNonce;
      const dist = camera.position.length() || radius * 4;
      const d = camera.position.clone().normalize();
      const az = Math.atan2(d.x, d.z);
      const el = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      const toAz = side === "bottom" ? Math.PI : 0; // head-on +Z (top) / −Z (bottom)
      anim.current = { az, el, dAz: wrapPi(toAz - az), dEl: -el, dist, start: null };
    }
    const a = anim.current;
    if (!a) return;
    if (a.start === null) a.start = state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - a.start) / 0.3);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const az = a.az + a.dAz * e;
    const el = a.el + a.dEl * e;
    const c = Math.cos(el);
    camera.position.set(Math.sin(az) * c * a.dist, Math.sin(el) * a.dist, Math.cos(az) * c * a.dist);
    camera.lookAt(0, 0, 0);
    controls?.update?.();
    if (t >= 1) anim.current = null;
  });
  return null;
}

/** Material for one surface layer, chosen by its kind. "other" uses the layer's
 *  own colour. */
function LayerMaterial({ kind, color }: { kind: number; color: string }) {
  switch (kind) {
    case KIND_COPPER:
      // Matte copper finish: high roughness scatters the highlight into a broad soft
      // sheen (no mirror), kept metallic so it still reads as metal; the env map is
      // dialed down so it catches the room softly instead of reflecting it sharply.
      return (
        <meshStandardMaterial
          color={COPPER_COLOR}
          roughness={0.72}
          metalness={0.85}
          envMapIntensity={0.75}
          side={THREE.DoubleSide}
        />
      );
    case KIND_MASK:
      return (
        <meshStandardMaterial
          color={MASK_COLOR}
          roughness={0.95}
          metalness={0.0}
          transparent
          opacity={0.9}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      );
    case KIND_SILK:
      return <meshStandardMaterial color={SILK_COLOR} roughness={0.85} metalness={0.0} side={THREE.DoubleSide} />;
    case KIND_BARREL:
      // Plated bore wall — copper, a touch rougher/duller than the pads.
      return (
        <meshStandardMaterial
          color={COPPER_COLOR}
          roughness={0.78}
          metalness={0.85}
          envMapIntensity={0.7}
          side={THREE.DoubleSide}
        />
      );
    default:
      return <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} side={THREE.DoubleSide} />;
  }
}

/** The 3D board view. ALL geometry is triangulated in the Rust core and arrives
 *  as ready-to-upload buffers (`mesh`); this component only places meshes and
 *  picks materials. Layer visibility is a pure show/hide of already-uploaded
 *  geometry (instant — no recompute), driven by `visibleKeys` (undefined = show
 *  everything). */
export function Board3D({
  mesh,
  visibleKeys,
  layerColors,
  initialZoom,
  side = "top",
  onFacingChange,
  snapNonce = 0,
}: {
  mesh: BoardMeshData | null;
  /** Keys of layers/drills to show. Undefined → show all. */
  visibleKeys?: Set<string>;
  /** Colour by layer key, used for "other" surface layers. */
  layerColors?: Record<string, string>;
  /** px/mm to open at — matches the 2D view so the scale carries over. */
  initialZoom?: number;
  /** Which side the 2D view was showing — 3D opens on the same side. */
  side?: "top" | "bottom";
  /** Reports the face the camera currently looks at (null when tilted away). */
  onFacingChange?: (f: "top" | "bottom" | null) => void;
  /** Bumped when the user picks a side → snaps the camera straight onto it. */
  snapNonce?: number;
}) {
  const { t } = useTranslation("project");
  if (!mesh) {
    return <PanelStatus loading message={t("building3d")} spinnerClassName="size-6" className="w-full" />;
  }
  const { center, radius } = mesh;
  return (
    <Canvas gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.48 }}>
      <SceneCamera initialZoom={initialZoom} radius={radius} side={side} />
      {/* Dark neutral background in tone with the app shell (light bg was glaring). */}
      <color attach="background" args={["#1b1f24"]} />
      {/* Image-based lighting so metallic copper reflects a room and never goes black. */}
      <SceneEnvironment />
      <hemisphereLight args={["#eaf0f6", "#10141a", 0.35]} />
      <ambientLight intensity={0.3} />
      {/* Headlamp: tracks the camera so the board is always lit toward the viewer.
          Softened now that the env map carries the metallic reflections. */}
      <HeadLight intensity={0.75} />
      <directionalLight position={[-40, 50, 30]} intensity={0.2} />
      {/* Centre the board at the origin. No Y flip: gerber and three.js are both Y-up. */}
      <group position={[-center[0], -center[1], -center[2]]}>
        {mesh.substrate.getAttribute("position") && (
          <mesh geometry={mesh.substrate}>
            {/* DoubleSide: the perimeter/cutout walls' winding follows the
                Edge_Cuts loop orientation (CW or CCW), so single-sided culling
                would drop the side walls on CW boards. */}
            <meshStandardMaterial color={FR4_COLOR} roughness={0.85} metalness={0.0} side={THREE.DoubleSide} />
          </mesh>
        )}
        {mesh.layers
          .filter((l) => !visibleKeys || visibleKeys.has(l.key))
          .map((l) => (
            <mesh key={l.key} geometry={l.geometry}>
              <LayerMaterial kind={l.kind} color={layerColors?.[l.key] ?? "#888888"} />
            </mesh>
          ))}
      </group>
      <OrbitControls makeDefault target={[0, 0, 0]} />
      <IntroFx radius={radius} side={side} />
      <SnapFx side={side} snapNonce={snapNonce} radius={radius} />
      <FacingReporter onChange={onFacingChange} />
      {/* Plasticity-style navigation cube: click a face to snap to that view. */}
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewcube />
      </GizmoHelper>
    </Canvas>
  );
}
