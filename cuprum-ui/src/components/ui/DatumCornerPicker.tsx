import { useTranslation } from "react-i18next";
import { type DatumCorner } from "@/lib/datum";

// 2×2 layout matching the panel: top row top-left/top-right, bottom row below.
const DATUM_GRID: [DatumCorner, DatumCorner][] = [
  ["top-left", "top-right"],
  ["bottom-left", "bottom-right"],
];

/** Shared 2×2 datum-corner selector. The datum is where machine 0,0 sits relative
 *  to the panel; it's the same setting (`drillDatumCorner`) whether chosen from the
 *  drill operation editor or the live machine panel. Renders only the grid — the
 *  caller supplies the heading (a `<p>` in the inspector, a Card title in the
 *  machine panel). Corner labels come from the `drill` namespace. */
export function DatumCornerPicker({
  value,
  onChange,
  className = "",
}: {
  value: DatumCorner;
  onChange: (d: DatumCorner) => void;
  className?: string;
}) {
  const { t } = useTranslation("drill");
  return (
    <div className={"grid grid-cols-2 gap-1.5 " + className}>
      {DATUM_GRID.flat().map((corner) => (
        <button
          key={corner}
          type="button"
          onClick={() => onChange(corner)}
          className={
            "rounded-md border px-2 py-1.5 text-[12px] transition-colors cursor-pointer " +
            (value === corner
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:border-slate-500 hover:text-foreground")
          }
        >
          {t(`datum.${corner}`)}
        </button>
      ))}
    </div>
  );
}
