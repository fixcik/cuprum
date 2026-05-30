import { Loader2, CheckCircle2, AlertTriangle, Printer } from "lucide-react";
import { useStore } from "@/store";

export function StatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const busy = useStore((s) => s.busy);
  const printer = useStore((s) => s.printer);
  const discover = useStore((s) => s.discover);

  let icon = null;
  let text = "Ready";
  if (error) {
    icon = <AlertTriangle className="size-3.5 text-destructive" />;
    text = error;
  } else if (busy) {
    icon = <Loader2 className="size-3.5 animate-spin text-primary" />;
    text = status?.message ?? "Working…";
  } else if (status?.stage === "done") {
    icon = <CheckCircle2 className="size-3.5 text-emerald-500" />;
    text = status.message;
  }

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-panel px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5 truncate">
        {icon}
        {text}
      </span>
      <button
        className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 tabular-nums hover:bg-muted/60"
        title="Click to scan for printers"
        onClick={() => discover()}
      >
        <Printer className={`size-3.5 ${printer ? "text-emerald-400" : "text-muted-foreground/60"}`} />
        {printer ? `${printer.name} · ${printer.ip}` : "scan for printer"}
      </button>
    </footer>
  );
}
