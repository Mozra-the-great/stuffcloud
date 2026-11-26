import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseBudget,
  type LighthouseCategory,
} from './perf-budget.ts';

// The arithmetic of the Lighthouse gate (T-25, #29): which score counts and whether it is enough.
// Plain functions, tested on both sides of every limit; the part that drives Chrome is
// `lighthouse-run.ts`.

/** The category scores of one Lighthouse run, each from 0 to 1. */
export type RunScores = Readonly<Record<LighthouseCategory, number>>;

export interface ScoreFinding {
  readonly category: LighthouseCategory;
  /** Median of the category over all runs. */
  readonly median: number;
  readonly min: number;
  /** Every run's score, in run order. */
  readonly runs: readonly number[];
  readonly ok: boolean;
}

/** The middle value of an odd number of values (the mean of the middle two for an even number). */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('the median of no values is undefined');
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/**
 * One finding per category: the median of the runs against the minimum score. Lighthouse scores
 * vary a little from run to run (CPU timing of the machine), so a single run decides nothing; the
 * threshold itself is never relaxed to absorb that.
 */
export function evaluateScores(
  runs: readonly RunScores[],
  budget: LighthouseBudget,
): ScoreFinding[] {
  if (runs.length === 0) {
    throw new Error('no Lighthouse run to evaluate');
  }
  return LIGHTHOUSE_CATEGORIES.map((category) => {
    const scores = runs.map((run) => run[category]);
    const middle = median(scores);
    const min = budget.minScores[category];
    return { category, median: middle, min, runs: scores, ok: middle >= min };
  });
}

function points(score: number): string {
  return String(Math.round(score * 100));
}

export function formatScores(findings: readonly ScoreFinding[]): string {
  const rows = findings.map(
    (finding) =>
      `| ${finding.ok ? 'ok' : 'BELOW'} | ${finding.category} | ${points(finding.median)} | ${points(finding.min)} | ${finding.runs.map(points).join(', ')} |`,
  );
  return ['| | Category | Median | Minimum | Runs |', '|---|---|---|---|---|', ...rows].join('\n');
}

export function formatScoreFailures(findings: readonly ScoreFinding[]): string {
  const below = findings.filter((finding) => !finding.ok);
  return [
    `Lighthouse: ${String(below.length)} categor${below.length === 1 ? 'y' : 'ies'} below the minimum:`,
    ...below.map(
      (finding) =>
        `- ${finding.category}: median ${points(finding.median)} of runs ${finding.runs.map(points).join(', ')}, minimum ${points(finding.min)}`,
    ),
    'Fix the cause (the HTML report of every run is in .lighthouse/). The minimum in perf-budgets.json is not lowered to get green (docs/PERFORMANCE.md).',
  ].join('\n');
}
