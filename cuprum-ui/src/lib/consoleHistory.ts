import { useCallback, useEffect, useState } from "react";

// Persisted, deduped log of *successfully executed* console commands. Shared
// across the in-app console drawer and the separate console OS window (both read
// the same localStorage key and stay in sync via the `storage` event), and it
// survives app restarts. Only commands GRBL acknowledged with `ok` land here —
// the up/down recall (which includes failed attempts) is a separate, in-memory
// per-session list owned by the console body.

const KEY = "cuprum-console-history";
const CAP = 100;

/** Read the saved command history (oldest → newest). Tolerates absent/corrupt
 *  storage by returning an empty list. */
export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(-CAP);
  } catch {
    return [];
  }
}

/** Append a command to the persisted history with move-to-front-on-repeat
 *  dedup (a re-run command jumps to newest, not duplicated) and a size cap.
 *  Blanks are ignored. Returns the new list. */
export function rememberCommand(cmd: string): string[] {
  const line = cmd.trim();
  if (!line) return loadHistory();
  const next = loadHistory().filter((c) => c !== line);
  next.push(line);
  const capped = next.slice(-CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    // Storage full/unavailable — recall still works from the in-memory session
    // list; persistence is best-effort.
  }
  return capped;
}

/** Classify a GRBL reply line. `ok` → the preceding command succeeded;
 *  `error:N` / `ALARM:N` → it failed; anything else (status reports, settings
 *  echoes, welcome banner) is not a terminal verdict. Case-insensitive. */
export function classifyResponse(text: string): "ok" | "error" | null {
  const t = text.trim().toLowerCase();
  if (t === "ok") return "ok";
  if (/^error:/.test(t) || /^alarm\b/.test(t)) return "error";
  return null;
}

/** React access to the shared history: returns the current list (newest last)
 *  and a `remember` to commit a successful command. Re-renders when another
 *  window mutates the same storage key. */
export function useConsoleHistory(): {
  history: string[];
  remember: (cmd: string) => void;
} {
  const [history, setHistory] = useState<string[]>(() => loadHistory());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setHistory(loadHistory());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const remember = useCallback((cmd: string) => setHistory(rememberCommand(cmd)), []);
  return { history, remember };
}
