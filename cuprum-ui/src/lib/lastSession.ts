import type { View } from "@/shellStore";

/** localStorage key holding the last on-screen project + view, so a webview
 *  reload or app restart can land the user back where they left off. */
const KEY = "cuprum-last-project";

export interface LastSession {
  /** Absolute path of the open `.cuprum`, or null when no project is open. */
  path: string | null;
  /** The view that was on screen at persist time. */
  view: View;
}

// `satisfies Record<View, true>` makes this fail to compile if a View member is
// missing — so adding a new view to the union forces updating this set, and the
// restore never silently drops an unknown view to Home.
const VIEW_SET = { home: true, project: true, equipment: true, settings: true } satisfies Record<View, true>;

function isView(v: unknown): v is View {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(VIEW_SET, v);
}

/** Parse a persisted last-session blob, tolerating absent/corrupt storage and
 *  legacy/garbage shapes. Returns null when there is nothing worth restoring:
 *  - no raw value, non-JSON, or a non-object shape;
 *  - the empty default (Home with no project) — the natural cold-start landing;
 *  - a "project" view without a path — degenerate, would show an empty editor.
 *  An unknown `view` falls back to "home"; an empty `path` is treated as null. */
export function parseLastSession(raw: string | null): LastSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const view: View = isView(rec.view) ? rec.view : "home";
  const path = typeof rec.path === "string" && rec.path.length > 0 ? rec.path : null;
  // Nothing to restore: a pathless Home/Project view is just the default landing
  // (equipment/settings are valid pathless views — they don't need a project).
  if (path === null && (view === "home" || view === "project")) return null;
  return { path, view };
}

/** Read the last session from localStorage; null when absent/unusable or storage
 *  is unavailable. */
export function loadLastSession(): LastSession | null {
  try {
    return parseLastSession(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Persist the last session. The empty default (pathless Home) clears the entry
 *  rather than pinning a stale value. Best-effort — storage may be unavailable. */
export function saveLastSession(s: LastSession): void {
  try {
    if (s.path === null && s.view === "home") {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify({ path: s.path, view: s.view }));
  } catch {
    /* best-effort: storage may be disabled/full */
  }
}
