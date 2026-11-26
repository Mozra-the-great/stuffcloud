/**
 * Entry of the benchmark page (`bench/index.html`, served by the Vite dev server only, never part
 * of the build). Exposes `window.__bench.run(options)`; `bench/run.ts` drives it through the
 * DevTools protocol. Opening the page with `?variant=css-transform&count=1` runs one variant by
 * hand and prints the result.
 */
import { MASCOT_SOURCES } from '@mozra-the-great/kern';
import { MASCOT_URLS } from '../src/app/mascots.ts';
import {
  runBench,
  startBench,
  type RunEnv,
  type RunningBench,
  type RunOptions,
  type RunResult,
} from './runner.ts';
import type { LayoutShiftSample } from './stats.ts';
import { isVariantName } from './variants/index.ts';

interface LayoutShiftEntry extends PerformanceEntry {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

function observe<T>(type: string, pick: (entry: PerformanceEntry) => T): () => readonly T[] {
  const collected: T[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      collected.push(pick(entry));
    }
  });
  try {
    observer.observe({ type, buffered: false });
  } catch {
    // The entry type is not supported by this browser: nothing is collected.
  }
  return (): readonly T[] => {
    observer.disconnect();
    return collected;
  };
}

const env: RunEnv = {
  document,
  devicePixelRatio: window.devicePixelRatio,
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => {
    window.cancelAnimationFrame(id);
  },
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (id) => {
    window.clearInterval(id);
  },
  fetchText: async (url) => (await fetch(url)).text(),
  loadImage: async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  },
  objectUrl: (svg) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    return {
      url,
      revoke: (): void => {
        URL.revokeObjectURL(url);
      },
    };
  },
  sleep: async (ms) => new Promise((done) => window.setTimeout(done, ms)),
  observeLayoutShifts: () =>
    observe<LayoutShiftSample>('layout-shift', (entry) => {
      const shift = entry as LayoutShiftEntry;
      return { value: shift.value, hadRecentInput: shift.hadRecentInput };
    }),
  observeLongTasks: () => observe<number>('longtask', (entry) => entry.duration),
  runningAnimations: () =>
    document.getAnimations().filter((animation) => animation.playState === 'running').length,
};

function stage(): HTMLElement {
  const host = document.getElementById('stage');
  if (host === null) {
    throw new Error('#stage is missing');
  }
  return host;
}

/** The main mascot: kern's pixel grid, the app's art file. */
const STUFFY = {
  url: MASCOT_URLS.stuffy,
  cols: MASCOT_SOURCES.stuffy.cols,
  rows: MASCOT_SOURCES.stuffy.rows,
} as const;

let pending: RunningBench | null = null;

async function start(options: RunOptions): Promise<void> {
  pending = await startBench(options, STUFFY, stage(), env);
}

async function finish(): Promise<RunResult> {
  if (pending === null) {
    throw new Error('no benchmark started');
  }
  const running = pending;
  pending = null;
  return running.finish();
}

async function run(options: RunOptions): Promise<RunResult> {
  return runBench(options, STUFFY, stage(), env);
}

declare global {
  interface Window {
    __bench: {
      /** Mounts a variant and starts observing; resolves when it is drawn. */
      readonly start: (options: RunOptions) => Promise<void>;
      /** Waits out the duration of the started run and returns its result. */
      readonly finish: () => Promise<RunResult>;
      readonly run: (options: RunOptions) => Promise<RunResult>;
    };
  }
}

window.__bench = { start, finish, run };

const query = new URLSearchParams(window.location.search);
const variant = query.get('variant');
if (variant !== null && isVariantName(variant)) {
  const out = document.getElementById('out');
  void run({
    variant,
    count: Number(query.get('count') ?? '1'),
    scale: Number(query.get('scale') ?? '16'),
    durationMs: Number(query.get('ms') ?? '4000'),
    sample: query.get('sample') !== '0',
  }).then((result) => {
    if (out !== null) {
      out.textContent = JSON.stringify(result, null, 2);
    }
  });
}
