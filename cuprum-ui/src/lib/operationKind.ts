import { Drill, Sun, Scissors, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";

/** Op types that appear as production steps and in run history. `expose` is shown
 *  as "UV" in the design. Mirrors `OperationRun.opType`. */
export type OpKind = "drill" | "expose" | "mill";

export interface OperationKind {
  kind: OpKind;
  icon: LucideIcon;
  /** Tailwind classes for the icon tile (bg + text) — same colour family in step
   *  cards and history rows. */
  tile: string;
  mode: "ready" | "preview";
  /** i18n keys under the `project` namespace. */
  titleKey: string;
  descKey: string;
  statusKey: string;
  /** Open the op's window. (drill/expose resolve to an already-open flag; mill
   *  resolves void — result is unused, so the return type is widened.) */
  openWindow: () => Promise<unknown>;
}

export const OPERATION_KINDS: OperationKind[] = [
  {
    kind: "drill",
    icon: Drill,
    tile: "bg-primary/15 text-primary",
    mode: "ready",
    titleKey: "operations.drill.title",
    descKey: "operations.drill.desc",
    statusKey: "operations.drill.status",
    openWindow: () => api.openDrillWindow(),
  },
  {
    kind: "expose",
    icon: Sun,
    tile: "bg-amber-400/15 text-amber-400",
    mode: "ready",
    titleKey: "operations.expose.title",
    descKey: "operations.expose.desc",
    statusKey: "operations.expose.status",
    openWindow: () => api.openExposeWindow(),
  },
  {
    kind: "mill",
    icon: Scissors,
    tile: "bg-[hsl(18_55%_45%/0.18)] text-[hsl(20_70%_60%)]",
    mode: "preview",
    titleKey: "operations.mill.title",
    descKey: "operations.mill.desc",
    statusKey: "operations.mill.status",
    openWindow: () => api.openMillWindow(),
  },
];

/** Lookup by opType; unknown types (future ops) fall back to the drill family so a
 *  history row still renders an icon. */
export function operationKind(opType: string): OperationKind {
  return OPERATION_KINDS.find((k) => k.kind === opType) ?? OPERATION_KINDS[0];
}
