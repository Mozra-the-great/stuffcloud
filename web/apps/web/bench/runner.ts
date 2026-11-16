import {
  frameStats,
  intervalsOf,
  layoutShiftTotal,
  type FrameStats,
  type LayoutShiftSample,
} from './stats.ts';
import { mountVariant, type BenchArt, type BenchEnv, type VariantName } from './variants/index.ts';

export interface RunOptions {
  readonly variant: VariantName;
  /** Number of mascots drawn at once. */
  readonly count: number;
  /** Integer CSS pixels per art pixel. */
  readonly scale: number;
  /** How long the variant runs while being observed. */
  readonly durationMs: number;
  /**
   * `true` runs a `requestAnimationFrame` sampler for frame statistics (it keeps the main thread
   * ticking at the display rate); `false` leaves the page idle so only the variant's own main
   * thread work shows up in the browser's counters.
   */
  readonly sample: boolean;
}

export interface RunResult {
  readonly options: RunOptions;
  /** Frame statistics; `null` when `sample` was off. */
  readonly frames: FrameStats | null;
  /** Cumulative layout shift from mount to stop. */
  readonly layoutShift: number;
  /** Tasks of 50 ms or more on the main thread (Long Tasks API). */
  readonly longTasks: { readonly count: number; readonly totalMs: number };
  /** Animations the browser runs for the page while the variant is mounted. */
  readonly runningAnimations: number;
}

/** The browser services of a run: the drawing services plus timing and observers. */
export interface RunEnv extends BenchEnv {
  sleep(ms: number): Promise<void>;
  /** Starts collecting layout shifts; the returned function stops and returns them. */
  observeLayoutShifts(): () => readonly LayoutShiftSample[];
  /** Starts collecting long task durations; the returned function stops and returns them. */
  observeLongTasks(): () => readonly number[];
  /** Number of animations currently running on the document. */
  runningAnimations(): number;
}

/** A variant that is mounted and observed; `finish` waits out the duration and reports. */
export interface RunningBench {
  readonly finish: () => Promise<RunResult>;
}

/**
 * Mounts the variant and starts observing. The returned promise resolves once the art is loaded
 * and drawn, so the cost of mounting stays out of what `finish` measures.
 */
export async function startBench(
  options: RunOptions,
  art: BenchArt,
  host: HTMLElement,
  env: RunEnv,
): Promise<RunningBench> {
  const collectShifts = env.observeLayoutShifts();
  const collectLongTasks = env.observeLongTasks();
  const mounted = await mountVariant(options.variant, {
    host,
    art,
    scale: options.scale,
    count: options.count,
    env,
  });
  const runningAnimations = env.runningAnimations();

  const timestamps: number[] = [];
  let sampler: number | null = null;
  if (options.sample) {
    const tick = (time: number): void => {
      timestamps.push(time);
      sampler = env.requestFrame(tick);
    };
    sampler = env.requestFrame(tick);
  }

  return {
    finish: async (): Promise<RunResult> => {
      await env.sleep(options.durationMs);
      if (sampler !== null) {
        env.cancelFrame(sampler);
      }
      mounted.stop();
      const longTasks = collectLongTasks();
      return {
        options,
        frames: options.sample ? frameStats(intervalsOf(timestamps)) : null,
        layoutShift: layoutShiftTotal(collectShifts()),
        longTasks: {
          count: longTasks.length,
          totalMs: longTasks.reduce((sum, ms) => sum + ms, 0),
        },
        runningAnimations,
      };
    },
  };
}

/** Mounts, observes for `options.durationMs` and reports, in one call. */
export async function runBench(
  options: RunOptions,
  art: BenchArt,
  host: HTMLElement,
  env: RunEnv,
): Promise<RunResult> {
  return (await startBench(options, art, host, env)).finish();
}
