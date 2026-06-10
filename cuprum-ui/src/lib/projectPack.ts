import { useShell } from "@/shellStore";
import { useArtifacts } from "@/artifactsStore";

/** Serialize ALL packs (mutations, restore points, artifact flush): two concurrent
 *  packs race on the container write + gc_gerbers vs collect_entries. */
let _packChain: Promise<unknown> = Promise.resolve();
/** Count of packs queued-but-not-yet-settled, so the UI can show a "saving"
 *  spinner while any repack (autosave flush included) is in flight. */
let _packInFlight = 0;
/** Set when a flush is requested while a pack is already in flight. Consumed once
 *  the queue drains: triggers exactly one trailing repack so no freshly-computed
 *  artifact is lost. */
let _flushDirty = false;

/** Whether a repack is currently queued or running. Consumers (artifact flush)
 *  read this to collapse concurrent flushes into a single trailing repack. */
export function isPackInFlight(): boolean {
  return _packInFlight > 0;
}

/** Mark that a fresh artifact flush arrived while the pack queue was busy. The
 *  flush will be fired once `serializePack` drains the queue. */
export function markFlushDirty(): void {
  _flushDirty = true;
}

/** Run `fn` on the shared single-flight pack chain. Toggles `useShell.saving`
 *  for the duration of the queue, and fires one trailing artifact flush if a
 *  flush was requested (markFlushDirty) while the queue was busy. */
export function serializePack(fn: () => Promise<void>): Promise<void> {
  _packInFlight += 1;
  if (_packInFlight === 1) useShell.setState({ saving: true });
  const run = () =>
    fn().finally(() => {
      _packInFlight -= 1;
      if (_packInFlight === 0) {
        useShell.setState({ saving: false });
        // If artifact flushes arrived while the pack queue was busy, fire one
        // trailing flush now that the queue is empty.  We clear the flag first
        // so a concurrent scheduleArtifactFlush (extremely unlikely here, but
        // possible) will start its own fresh debounce rather than be swallowed.
        if (_flushDirty) {
          _flushDirty = false;
          useArtifacts.getState().scheduleArtifactFlush(true);
        }
      }
    });
  const next = _packChain.then(run, run);
  _packChain = next.catch(() => {});
  return next;
}
