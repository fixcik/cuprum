import { useEffect } from "react";

/** Direction of a jog hotkey: arrows → XY, PageUp/PageDown → Z. */
function dirOf(key: string): [number, number, number] | null {
  switch (key) {
    case "ArrowUp":
      return [0, 1, 0];
    case "ArrowDown":
      return [0, -1, 0];
    case "ArrowLeft":
      return [-1, 0, 0];
    case "ArrowRight":
      return [1, 0, 0];
    case "PageUp":
      return [0, 0, 1];
    case "PageDown":
      return [0, 0, -1];
    default:
      return null;
  }
}

const isTyping = (el: HTMLElement | null) =>
  !!el &&
  (el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable);

export interface JogHotkeysOpts {
  /** Master gate — no listeners fire while false (offline/alarm/busy). */
  enabled: boolean;
  /** Continuous ("∞") jog mode: keydown starts, keyup stops, OS auto-repeat ignored. */
  continuous: boolean;
  /** One step in the given direction (step mode; auto-repeat keeps stepping). */
  go: (dx: number, dy: number, dz: number) => void;
  startContinuous: (dx: number, dy: number, dz: number) => void | Promise<unknown>;
  stopContinuous: () => void;
  /** Optional Z override: PageUp/PageDown call this (step mode semantics, auto-
   *  repeat allowed) instead of go/startContinuous — the points wizard routes
   *  Z− through the slow safe-descent path this way. */
  onZStep?: (dz: 1 | -1) => void;
}

/** Keyboard jog shared by the jog pad and the work-zero binding screens:
 *  arrows jog XY, PageUp/PageDown jog Z. Skips events while typing in a form
 *  field. In step mode a keydown emits one move (auto-repeat keeps stepping);
 *  in continuous mode the first keydown starts the move and keyup stops it
 *  (`e.repeat` is ignored so a hold is one jog, not a stream of re-starts). */
export function useJogHotkeys({
  enabled,
  continuous,
  go,
  startContinuous,
  stopContinuous,
  onZStep,
}: JogHotkeysOpts) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target as HTMLElement | null)) return;
      const dir = dirOf(e.key);
      if (!dir) return;
      e.preventDefault();
      if (onZStep && dir[2] !== 0) {
        onZStep(dir[2] as 1 | -1);
        return;
      }
      if (continuous) {
        // Ignore the OS key-repeat: hold = one continuous move.
        if (e.repeat) return;
        void startContinuous(dir[0], dir[1], dir[2]);
      } else {
        go(dir[0], dir[1], dir[2]);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!continuous) return;
      const dir = dirOf(e.key);
      if (!dir || (onZStep && dir[2] !== 0)) return;
      e.preventDefault();
      stopContinuous();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, continuous, go, startContinuous, stopContinuous, onZStep]);
}
