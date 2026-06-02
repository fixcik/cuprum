/** Per-operation weights for one design's artifact ring. svg and preview each
 *  render all layers (~1s); metrics is the heavy step (~6.6s). Sum = 1. */
export const ARTIFACT_WEIGHTS = { svg: 0.15, preview: 0.15, metrics: 0.7 } as const;

export interface ArtifactDone {
  svg: boolean;
  preview: boolean;
  metrics: boolean;
}

/** Weighted 0..1 completion of one design's artifacts. */
export function ringFraction(done: ArtifactDone): number {
  return (
    (done.svg ? ARTIFACT_WEIGHTS.svg : 0) +
    (done.preview ? ARTIFACT_WEIGHTS.preview : 0) +
    (done.metrics ? ARTIFACT_WEIGHTS.metrics : 0)
  );
}

/** Aggregate per-design fractions into an overall view. `done` counts designs at
 *  fraction >= 1; `fraction` is the mean (0..1). Empty → fully done. */
export function overallProgress(byDesign: Record<string, number>): {
  done: number;
  total: number;
  fraction: number;
} {
  const vals = Object.values(byDesign);
  const total = vals.length;
  if (total === 0) return { done: 0, total: 0, fraction: 1 };
  const done = vals.filter((v) => v >= 1).length;
  const fraction = vals.reduce((a, b) => a + b, 0) / total;
  return { done, total, fraction };
}
