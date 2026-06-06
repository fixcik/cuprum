import { useTranslation } from "react-i18next";
import type { DrillRoute, RouteGroup } from "@/lib/drillRoute";
import type { Tool } from "@/lib/toolLibrary";
import type { DrillClass } from "@/lib/api";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { groupColor } from "@/components/drill/DrillMapCanvas";
import { nearestBit } from "@/lib/drillBitOverride";

const CLASS_LABEL: Record<RouteGroup["class"], string> = {
  registration: "drill:class.registration",
  pth: "drill:class.pth",
  npth: "drill:class.npth",
  mechanical: "drill:class.mechanical",
};

export interface DrillToolsOrderProps {
  route: DrillRoute;
  tools: Tool[];
  onSetClass: (diameterMm: number, klass: DrillClass | null) => void;
  onSetBitOverride: (diameterKey: string, toolId: string) => void;
}

/** Ordered list of drill groups (in drill execution order) with class dropdown
 *  and a "take nearest bit" action for unmatched diameters. */
export function DrillToolsOrder({
  route,
  tools,
  onSetClass,
  onSetBitOverride,
}: DrillToolsOrderProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const toolChanges = route.groups.filter((g) => g.toolId !== null).length;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm text-slate-300">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-100">{t("toolsOrder.title")}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs tabular-nums text-slate-400">
          {t("toolsOrder.bitChanges", { count: toolChanges })}
        </span>
      </div>

      {/* Per-group list in drill order */}
      <ul className="flex flex-col gap-1.5">
        {route.groups.map((g, gi) => {
          const color = groupColor(gi);
          const diameterKey = String(Math.round(g.diameterMm * 1000));
          const nearest = g.toolId === null ? nearestBit(g.diameterMm, tools) : null;

          return (
            <li key={gi} className="flex flex-col gap-0.5">
              {/* Main row */}
              <div className="flex items-center gap-2">
                {/* Order number circle */}
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {gi + 1}
                </span>
                {/* Colour dot */}
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {/* Diameter */}
                <span className="tabular-nums text-slate-100">{fmtLen(g.diameterMm)}</span>
                {/* Class dropdown */}
                <select
                  className="bg-transparent text-slate-400 text-xs outline-none cursor-pointer hover:text-slate-200"
                  value={g.class}
                  onChange={(e) =>
                    onSetClass(
                      g.diameterMm,
                      e.target.value === "" ? null : (e.target.value as RouteGroup["class"]),
                    )
                  }
                  aria-label={t("class.aria")}
                >
                  <option value="">{t("class.auto")}</option>
                  {(["registration", "pth", "npth", "mechanical"] as const).map((c) => (
                    <option key={c} value={c}>
                      {t(CLASS_LABEL[c])}
                    </option>
                  ))}
                </select>
                {/* Hole count chip */}
                <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-500">
                  {g.orderedHoles.length}
                </span>
              </div>

              {/* Amber sub-row when no matching bit */}
              {g.toolId === null && (
                <div className="ml-7 flex items-center gap-2 text-xs text-amber-400">
                  <span>{t("toolsOrder.noBit", { diameter: fmtLen(g.diameterMm) })}</span>
                  {nearest !== null && (
                    <button
                      type="button"
                      className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300 hover:bg-amber-500/30 transition-colors"
                      onClick={() => onSetBitOverride(diameterKey, nearest.id)}
                    >
                      {t("toolsOrder.takeBit", { diameter: fmtLen(nearest.diameterMm) })}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
