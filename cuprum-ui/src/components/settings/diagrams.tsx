// Tiny schematic SVG diagrams for the settings tooltips. Copper = gold, mask =
// green, FR4 = dark olive; dimension lines use currentColor (theme foreground).
import type { ReactNode } from "react";

const COPPER = "#caa84a";
const MASK = "#2e6e40";
const FR4 = "#59512c";
const SILK = "#e8e8e8";

function Diag({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 120 60" width={132} height={66} role="img">
      {children}
    </svg>
  );
}

/** Horizontal dimension line with end ticks at y, from x1..x2. */
function HDim({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return (
    <g stroke="currentColor" strokeWidth={1}>
      <line x1={x1} y1={y} x2={x2} y2={y} />
      <line x1={x1} y1={y - 3} x2={x1} y2={y + 3} />
      <line x1={x2} y1={y - 3} x2={x2} y2={y + 3} />
    </g>
  );
}

/** Vertical dimension line with end ticks at x, from y1..y2. */
function VDim({ y1, y2, x }: { y1: number; y2: number; x: number }) {
  return (
    <g stroke="currentColor" strokeWidth={1}>
      <line x1={x} y1={y1} x2={x} y2={y2} />
      <line x1={x - 3} y1={y1} x2={x + 3} y2={y1} />
      <line x1={x - 3} y1={y2} x2={x + 3} y2={y2} />
    </g>
  );
}

export const Diagrams = {
  panelSize: (
    <Diag>
      <rect x={14} y={10} width={92} height={36} fill={FR4} stroke={COPPER} strokeWidth={1.5} />
      <HDim x1={14} x2={106} y={52} />
      <VDim y1={10} y2={46} x={8} />
    </Diag>
  ),
  traceWidth: (
    <Diag>
      <rect x={10} y={26} width={100} height={9} fill={COPPER} />
      <VDim y1={26} y2={35} x={6} />
    </Diag>
  ),
  clearance: (
    <Diag>
      <rect x={10} y={18} width={45} height={24} fill={COPPER} />
      <rect x={65} y={18} width={45} height={24} fill={COPPER} />
      <HDim x1={55} x2={65} y={48} />
    </Diag>
  ),
  copperWidth: (
    <Diag>
      <path d="M10 12 H50 V25 H70 V12 H110 V48 H70 V35 H50 V48 H10 Z" fill={COPPER} />
      <VDim y1={25} y2={35} x={60} />
    </Diag>
  ),
  drill: (
    <Diag>
      <circle cx={60} cy={28} r={20} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <HDim x1={40} x2={80} y={28} />
    </Diag>
  ),
  annular: (
    <Diag>
      <circle cx={60} cy={28} r={24} fill={COPPER} />
      <circle cx={60} cy={28} r={11} fill={FR4} />
      <HDim x1={60} x2={84} y={28} />
      <line x1={60} y1={28} x2={71} y2={28} stroke="currentColor" strokeWidth={2} />
    </Diag>
  ),
  maskDam: (
    <Diag>
      <rect x={10} y={16} width={100} height={28} fill={MASK} />
      <rect x={20} y={22} width={28} height={16} fill={FR4} />
      <rect x={72} y={22} width={28} height={16} fill={FR4} />
      <HDim x1={48} x2={72} y={50} />
    </Diag>
  ),
  silkLine: (
    <Diag>
      <rect x={10} y={14} width={100} height={32} fill={MASK} />
      <rect x={10} y={27} width={100} height={6} fill={SILK} />
      <VDim y1={27} y2={33} x={6} />
    </Diag>
  ),
  overshoot: (
    <Diag>
      <rect x={14} y={12} width={70} height={36} fill={FR4} stroke={COPPER} strokeWidth={1.5} />
      <rect x={78} y={24} width={26} height={12} fill={COPPER} />
      <HDim x1={84} x2={104} y={44} />
    </Diag>
  ),
};
