import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, History, PanelRightClose, Terminal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useMachineActions } from "@/components/machine/MachineActionsContext";
import { classifyResponse, loadHistory, useConsoleHistory } from "@/lib/consoleHistory";

/** Local wall-clock time of a console line as HH:MM:SS.mmm. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
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
  const [histOpen, setHistOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  // Persisted, successful-only command history (shared across windows) — drives
  // the dropdown picker. The up/down recall walks a separate in-memory list that
  // also includes failed attempts (see `recallRef`).
  const { history, remember } = useConsoleHistory();

  // In-memory recall ring for the up/down arrows. Seeded from the saved history
  // on mount so the first ↑ already reaches past successful commands, then every
  // submitted command (success OR failure) is appended live. `recallPos` indexes
  // it; `=== length` means "at the live draft" (not navigating). `draftRef` keeps
  // the in-progress text stashed while the user walks back through history.
  const recallRef = useRef<string[]>([]);
  const recallPos = useRef(0);
  const draftRef = useRef("");

  // Awaiting GRBL's verdict for the last manually-sent command: the first `ok`
  // after `afterSeq` commits it to the saved history; the first `error:`/`ALARM`
  // drops it. Only set by manual console sends, so auto-traffic never pollutes it.
  const pendingRef = useRef<{ cmd: string; afterSeq: number } | null>(null);

  // Seed the recall ring from the saved history once, on mount.
  useEffect(() => {
    recallRef.current = loadHistory();
    recallPos.current = recallRef.current.length;
  }, []);

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

  // Resolve a pending command against the incoming reply stream — but only AFTER
  // our own tx echo lands. `a.send` is fire-and-forget, so `afterSeq` predates the
  // echo; anchoring the verdict on the matching tx line (the backend echoes the
  // exact text) makes the scan ignore any `ok` from background traffic already in
  // flight (e.g. a `$$` query whose reply interleaves), which would otherwise be
  // misread as this command's verdict. A valid reply (`ok`/`ALARM` — the line was
  // well-formed) after the echo commits it; an `error:` (rejected) drops it.
  useEffect(() => {
    const p = pendingRef.current;
    if (!p) return;
    let echoed = false;
    for (const l of lines) {
      if (l.seq <= p.afterSeq) continue;
      if (!echoed) {
        if (l.dir === "tx" && l.text === p.cmd) echoed = true;
        continue;
      }
      if (l.dir !== "rx") continue;
      const verdict = classifyResponse(l.text);
      if (verdict === "valid") {
        remember(p.cmd);
        pendingRef.current = null;
        break;
      }
      if (verdict === "invalid") {
        pendingRef.current = null;
        break;
      }
    }
  }, [lines, remember]);

  // Close the history dropdown on an outside click.
  useEffect(() => {
    if (!histOpen) return;
    const onDown = (e: PointerEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setHistOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [histOpen]);

  const send = () => {
    const line = input.trim();
    if (!line || !connected) return;
    a.send(line);
    // Always recall-able (success or not); mark pending for the success verdict.
    recallRef.current.push(line);
    recallPos.current = recallRef.current.length;
    draftRef.current = "";
    // Overwrite any prior unresolved pending: a new send supersedes it. This also
    // self-heals commands that never draw an `ok` (e.g. a bare `?` status query,
    // sent as a real-time byte) — they'd otherwise stay pending forever.
    pendingRef.current = { cmd: line, afterSeq: lines.length ? lines[lines.length - 1].seq : 0 };
    setInput("");
  };

  // Replace the input with `value` and leave recall at the live draft, so a
  // following ↑ starts a fresh walk from the newest command.
  const setLive = (value: string) => {
    setInput(value);
    recallPos.current = recallRef.current.length;
  };

  const pick = (cmd: string) => {
    setLive(cmd);
    setHistOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      send();
      return;
    }
    const r = recallRef.current;
    if (e.key === "ArrowUp") {
      if (r.length === 0) return;
      e.preventDefault();
      // Entering navigation from the live draft — stash what was typed.
      if (recallPos.current === r.length) draftRef.current = input;
      if (recallPos.current > 0) {
        recallPos.current -= 1;
        setInput(r[recallPos.current]);
      }
    } else if (e.key === "ArrowDown") {
      if (recallPos.current >= r.length) return;
      e.preventDefault();
      recallPos.current += 1;
      setInput(recallPos.current === r.length ? draftRef.current : r[recallPos.current]);
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
      <div
        ref={rowRef}
        className="relative flex shrink-0 items-center gap-2 border-t border-border p-2.5"
      >
        {histOpen && history.length > 0 && (
          <div className="absolute bottom-full left-2.5 right-2.5 mb-2 max-h-56 overflow-auto rounded-md border border-border bg-popover py-1 shadow-2xl">
            {[...history].reverse().map((cmd, i) => (
              <button
                key={`${i}-${cmd}`}
                type="button"
                onClick={() => pick(cmd)}
                className="block w-full select-none truncate px-3 py-1.5 text-left font-mono text-[12px] text-foreground hover:bg-foreground/10"
              >
                {cmd}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          title={t("console.history")}
          disabled={history.length === 0}
          onClick={() => setHistOpen((v) => !v)}
          className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
        >
          <History className="size-4" />
        </button>
        <input
          ref={inputRef}
          value={input}
          disabled={!connected}
          placeholder={t("console.placeholder")}
          onChange={(e) => setLive(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
        <Button onClick={send} disabled={!connected}>
          {t("console.send")}
        </Button>
      </div>
    </div>
  );
}

/** Right-side slide-in console drawer over the content. When the console is
 *  popped out to its own OS window the host closes this drawer entirely (no stub),
 *  so it only ever renders the live console body. */
export function ConsoleDrawer({
  open,
  onClose,
  onPopOut,
}: {
  open: boolean;
  onClose: () => void;
  onPopOut?: () => void;
}) {
  if (!open) return null;
  return (
    <div className="slide-in absolute inset-y-0 right-0 z-20 w-[440px] max-w-full border-l border-border shadow-2xl">
      <ConsoleBody onClose={onClose} onPopOut={onPopOut} />
    </div>
  );
}
