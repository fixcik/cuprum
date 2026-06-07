import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, PanelRightClose, Terminal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useMachineActions } from "@/components/machine/MachineActionsContext";

/** Local wall-clock time of a console line as HH:MM:SS.mmm. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Stub shown in the drawer while the console is open in a separate OS window. */
function ConsoleStub({
  onClose,
  onFocus,
}: {
  onClose: () => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation("machine");
  return (
    <div className="flex h-full flex-col bg-card">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Terminal className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("console.title")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title={t("console.close")}
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-[13px] text-muted-foreground">{t("console.inWindow")}</p>
        <Button variant="secondary" size="sm" onClick={onFocus}>
          {t("console.focusWindow")}
        </Button>
      </div>
    </div>
  );
}

/** Inner console body: header (title + line count + copy + close), scrolling log
 *  with auto-scroll, and the G-code input. Reused by the drawer and the console window. */
export function ConsoleBody({
  onClose,
  onPopOut,
}: {
  onClose: () => void;
  onPopOut?: () => void;
}) {
  const { t } = useTranslation("machine");
  const a = useMachineActions();
  const lines = useMachine((s) => s.lines);
  const connected = useMachine((s) => s.connected);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  // Auto-scroll the log to the bottom on new lines — but scroll ONLY this
  // container (`scrollTop`), never `scrollIntoView`, which would also yank every
  // scrollable ancestor and make the whole panel jump. On first open jump to the
  // bottom unconditionally; afterwards stick to the bottom only when the user is
  // already there, so manual scroll-back isn't fought.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (firstScroll.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      firstScroll.current = false;
    }
  }, [lines]);

  const send = () => {
    const line = input.trim();
    if (line && connected) {
      a.send(line);
      setInput("");
    }
  };

  const copyLog = () => {
    const text = lines
      .map((l) => `${fmtTime(l.ts)} ${l.dir === "tx" ? "»" : "‹"} ${l.text}`)
      .join("\n");
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Terminal className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("console.title")}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {lines.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={copyLog}
            disabled={lines.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
          >
            <Copy className="size-3.5" />
            {copied ? t("console.copied") : t("console.copy")}
          </button>
          {onPopOut && (
            <button
              type="button"
              title={t("console.popOut")}
              onClick={onPopOut}
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </button>
          )}
          <button
            type="button"
            title={t("console.close")}
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </header>
      {/* select-text overrides the app-global `user-select: none` so the operator
          can copy console output (g-code, errors). */}
      <div
        ref={logRef}
        className="min-h-0 flex-1 select-text overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
      >
        {lines.map((l) => (
          <div key={l.seq} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 select-none tabular-nums text-muted-foreground/40">
              {fmtTime(l.ts)}
            </span>
            <span
              className={`shrink-0 select-none ${l.dir === "tx" ? "text-primary" : "text-muted-foreground/50"}`}
            >
              {l.dir === "tx" ? "›" : "‹"}
            </span>
            <span
              className={
                l.dir === "tx"
                  ? "text-foreground"
                  : /ALARM|error/i.test(l.text)
                    ? "text-destructive"
                    : "text-muted-foreground"
              }
            >
              {l.text}
            </span>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-2.5">
        <input
          value={input}
          disabled={!connected}
          placeholder={t("console.placeholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
        <Button onClick={send} disabled={!connected}>
          {t("console.send")}
        </Button>
      </div>
    </div>
  );
}

/** Right-side slide-in console drawer over the content. */
export function ConsoleDrawer({
  open,
  onClose,
  windowOpen = false,
  onPopOut,
  onFocusWindow,
}: {
  open: boolean;
  onClose: () => void;
  windowOpen?: boolean;
  onPopOut?: () => void;
  onFocusWindow?: () => void;
}) {
  if (!open) return null;
  return (
    <div className="slide-in absolute inset-y-0 right-0 z-20 w-[440px] max-w-full border-l border-border shadow-2xl">
      {windowOpen ? (
        <ConsoleStub
          onClose={onClose}
          onFocus={() => onFocusWindow?.()}
        />
      ) : (
        <ConsoleBody onClose={onClose} onPopOut={onPopOut} />
      )}
    </div>
  );
}
