import { DrillOperationEditor } from "@/components/operations/DrillOperationEditor";

/** Root of the separate drill-preview window (label "drill").
 *  Delegates all rendering to DrillOperationEditor, which sources its snapshot
 *  directly from the stores (no IPC) — the separate window still works via the
 *  existing useDrillBridge in App.tsx pushing store changes. */
export function DrillWindow() {
  return <DrillOperationEditor />;
}
