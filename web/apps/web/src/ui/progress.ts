/** A usable maximum: non-positive or non-finite values fall back to 100. */
export function normaliseMax(max: number): number {
  return Number.isFinite(max) && max > 0 ? max : 100;
}

/**
 * Share of `value` in `max` as a percentage in [0, 100]. A non-positive or non-finite `max`
 * is treated as 100 and a non-finite `value` as 0, so a bad input never draws a broken bar.
 */
export function progressPercent(value: number, max = 100): number {
  const safeMax = normaliseMax(max);
  const safeValue = Number.isFinite(value) ? value : 0;
  const clamped = Math.min(Math.max(safeValue, 0), safeMax);
  return (clamped / safeMax) * 100;
}
