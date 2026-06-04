import { useTranslation } from "react-i18next";
import { copperMicrons, stackupTotalMm } from "@/lib/stackup";

const COPPER = "#caa84a";
const MASK = "#257d55";
const FR4 = "#6b5d34";

/** Live cross-section of the FR4 blank: mask / copper / core / copper / mask.
 *  Reacts to sides (single/double), copper weight and substrate thickness.
 *  Schematic only — band heights are screen px, not to scale. */
export function StackupDiagram({
  copperWeight,
  substrateMm,
  doubleSided,
}: {
  copperWeight: number;
  substrateMm: number;
  doubleSided: boolean;
}) {
  const { t } = useTranslation("project");
  const cuMic = copperMicrons(copperWeight);
  const Wd = 240;
  const pad = 8;
  const x0 = pad;
  const x1 = Wd - pad;
  const bw = x1 - x0;
  const cuH = Math.round(3 + copperWeight * 3.5);
  const maskH = 2.5;
  const coreH = Math.round(14 + Math.min(substrateMm, 3) * 16);

  const bands: { y: number; h: number; fill: string }[] = [];
  const dims: { cy: number; label: string }[] = [];
  let y = 10;
  const band = (h: number, fill: string, label?: string) => {
    bands.push({ y, h, fill });
    if (label) dims.push({ cy: y + h / 2, label });
    y += h;
  };
  const cuLabel = t("setup.stackupCopper", { mic: cuMic });
  if (doubleSided) {
    band(maskH, MASK);
    band(cuH, COPPER, cuLabel);
  }
  band(coreH, FR4, t("setup.stackupFr4", { mm: substrateMm.toFixed(2) }));
  band(cuH, COPPER, doubleSided ? undefined : cuLabel);
  band(maskH, MASK);
  const H = y + 10;
  const top = 8;
  const bot = H - 8;
  const total = stackupTotalMm(substrateMm, copperWeight, doubleSided).toFixed(2);

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <svg viewBox={`0 0 ${Wd + 130} ${H}`} width="100%" style={{ maxHeight: 150, overflow: "visible" }} role="img">
        {/* left total bracket */}
        <line x1={3} y1={top} x2={3} y2={bot} stroke="hsl(215 14% 38%)" strokeWidth={1} />
        <line x1={3} y1={top} x2={6} y2={top} stroke="hsl(215 14% 38%)" />
        <line x1={3} y1={bot} x2={6} y2={bot} stroke="hsl(215 14% 38%)" />
        {bands.map((b, i) => (
          <rect key={i} x={x0} y={b.y} width={bw} height={b.h} fill={b.fill} stroke="rgba(0,0,0,.35)" strokeWidth={0.5} />
        ))}
        {dims.map((d, i) => (
          <g key={i}>
            <line x1={x1} y1={d.cy} x2={x1 + 12} y2={d.cy} stroke="hsl(215 14% 38%)" strokeWidth={1} />
            <text x={x1 + 16} y={d.cy + 3.5} fill="hsl(215 14% 62%)" fontSize={10.5} fontFamily="ui-sans-serif">
              {d.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{doubleSided ? t("setup.stackupDouble") : t("setup.stackupSingle")}</span>
        <span className="tabular-nums">{t("setup.stackupTotal", { mm: total })}</span>
      </div>
    </div>
  );
}
