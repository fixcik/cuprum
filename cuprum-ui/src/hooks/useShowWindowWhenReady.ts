import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Reveal the current Tauri window only once its content is ready, so secondary
 *  windows (add-design, inspector) appear already-rendered instead of flashing the
 *  blank webview + boot spinner while the bundle loads ("looks like a web page").
 *
 *  The window must be created hidden (`.visible(false)` in the Rust builder). This
 *  hook shows it on the frame after `ready` first becomes true, and — as a safety
 *  net so a window can never get stuck hidden — also shows it after `fallbackMs`
 *  regardless. Showing is idempotent and also focuses the window.
 *
 *  @param ready       becomes true when the window has meaningful content to show
 *                     (e.g. the first project snapshot has arrived).
 *  @param fallbackMs  hard upper bound before showing anyway (default 1500 ms).
 */
export function useShowWindowWhenReady(ready: boolean, fallbackMs = 1500): void {
  const shownRef = useRef(false);

  const show = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    const w = getCurrentWindow();
    void w.show();
    void w.setFocus();
  }, []);

  // Safety net: never leave the window hidden even if `ready` never flips. If the
  // root unmounts before the timer fires (e.g. the window closes itself), reveal it
  // in the cleanup too — show() is idempotent, so this can't double-show.
  useEffect(() => {
    const t = setTimeout(show, fallbackMs);
    return () => {
      clearTimeout(t);
      show();
    };
  }, [show, fallbackMs]);

  // Show on the next frame after content is ready, so the first paint with real
  // content lands before the window becomes visible.
  useEffect(() => {
    if (!ready) return;
    const raf = requestAnimationFrame(() => show());
    return () => cancelAnimationFrame(raf);
  }, [ready, show]);
}
