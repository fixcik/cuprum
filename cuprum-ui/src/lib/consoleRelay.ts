import type { ConsoleLine } from "@/machineStore";

/** Lines newer than `lastSeq`. Uses the monotonic per-line `seq` so it stays
 *  correct even after the ring buffer drops old lines off the front. */
export function linesSince(lines: ConsoleLine[], lastSeq: number): ConsoleLine[] {
  return lines.filter((l) => l.seq > lastSeq);
}
