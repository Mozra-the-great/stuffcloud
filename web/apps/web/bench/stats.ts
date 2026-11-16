/** Pure helpers of the animation benchmark: frame statistics and metric arithmetic. */

/** One 60 Hz frame. */
export const FRAME_BUDGET_MS = 1000 / 60;

/** A frame counts as dropped when it took longer than this many budgets (a missed vsync). */
export const DROPPED_FRAME_FACTOR = 1.5;

export interface FrameStats {
  readonly frames: number;
  readonly fps: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly dropped: number;
}

/** Nearest-rank percentile of an ascending list; `p` in [0, 100]; 0 for an empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  const last = sorted.length - 1;
  if (last < 0) {
    return 0;
  }
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), last)] ?? 0;
}

/** Statistics over frame-to-frame intervals in milliseconds. */
export function frameStats(intervals: readonly number[], budgetMs = FRAME_BUDGET_MS): FrameStats {
  if (intervals.length === 0) {
    return { frames: 0, fps: 0, medianMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, dropped: 0 };
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  return {
    frames: intervals.length,
    fps: total > 0 ? (intervals.length / total) * 1000 : 0,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.at(-1) ?? 0,
    dropped: intervals.filter((value) => value > budgetMs * DROPPED_FRAME_FACTOR).length,
  };
}

/** Timestamps of consecutive frames as intervals. */
export function intervalsOf(timestamps: readonly number[]): number[] {
  return timestamps.slice(1).map((time, index) => time - (timestamps[index] ?? time));
}

export interface LayoutShiftSample {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

/** Cumulative layout shift: shifts right after user input do not count (web.dev definition). */
export function layoutShiftTotal(samples: readonly LayoutShiftSample[]): number {
  return samples
    .filter((sample) => !sample.hadRecentInput)
    .reduce((sum, sample) => sum + sample.value, 0);
}

export type Metrics = Readonly<Record<string, number>>;

/** `after - before` for every metric present in both; counters and durations only grow. */
export function metricsDelta(before: Metrics, after: Metrics): Metrics {
  const delta: Record<string, number> = {};
  for (const [name, value] of Object.entries(after)) {
    const start = before[name];
    if (start !== undefined) {
      delta[name] = value - start;
    }
  }
  return delta;
}

/** Share of the wall time the main thread was busy, in percent. */
export function busyPercent(taskSeconds: number, wallMs: number): number {
  return wallMs > 0 ? (taskSeconds * 1000 * 100) / wallMs : 0;
}
