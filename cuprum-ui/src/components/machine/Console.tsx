import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";

/** Local wall-clock time of a console line as HH:MM:SS.mmm. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function Console() {
  const { t } = useTranslation("machine");
  const lines = useMachine((s) => s.lines);
  const connected = useMachine((s) => s.connected);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const send = () => {
    const line = input.trim();
    if (line && connected) {
      void api.machine.send(line);
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
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span>{t("console.title")}</span>
        <button
          onClick={copyLog}
          disabled={lines.length === 0}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {copied ? t("console.copied") : t("console.copy")}
        </button>
      </div>
      {/* select-text overrides the app-global `user-select: none` (styles.css) so
          the operator can select/copy console output (e.g. g-code, errors). */}
      <div className="min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={l.dir === "tx" ? "text-primary" : "text-muted-foreground"}>
            <span className="select-none opacity-40">{fmtTime(l.ts)} </span>
            <span className="select-none opacity-50">{l.dir === "tx" ? "» " : "‹ "}</span>
            {l.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-border p-2">
        <input
          value={input}
          disabled={!connected}
          placeholder={t("console.placeholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!connected}
          className="rounded-md bg-primary/20 px-3 text-xs text-primary disabled:opacity-50"
        >
          {t("console.send")}
        </button>
      </div>
    </div>
  );
}
