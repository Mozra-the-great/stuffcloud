/** Command line, Chrome lookup and result tables of the benchmark driver (`bench/run.ts`). */
import { busyPercent, type FrameStats, type Metrics } from './stats.ts';
import { isVariantName, VARIANT_NAMES, type VariantName } from './variants/types.ts';

export type Mode = 'bench' | 'verify' | 'size';

export interface CliOptions {
  readonly mode: Mode;
  readonly variants: readonly VariantName[];
  /** Mascots drawn at once, one run per entry. */
  readonly counts: readonly number[];
  /** CPU slowdown factors (1 = none), one run per entry. */
  readonly throttles: readonly number[];
  readonly durationMs: number;
  readonly scale: number;
  /** Path to a Chrome or Chromium binary; looked up when unset. */
  readonly chrome: string | undefined;
}

export const DEFAULT_OPTIONS: Omit<CliOptions, 'mode'> = {
  variants: VARIANT_NAMES,
  counts: [1, 64],
  throttles: [1, 6],
  durationMs: 4000,
  scale: 16,
  chrome: undefined,
};

export const USAGE =
  'usage: node bench/run.ts <bench|verify|size> [--variants a,b] [--counts 1,64] ' +
  '[--throttles 1,6] [--duration ms] [--scale n] [--chrome path]';

function positiveInteger(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} needs positive whole numbers, got "${text}"`);
  }
  return value;
}

function integerList(text: string, flag: string): number[] {
  return text.split(',').map((item) => positiveInteger(item.trim(), flag));
}

/** Parses `argv` (without node and script); throws an error with the usage on bad input. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const [mode, ...rest] = argv;
  if (mode !== 'bench' && mode !== 'verify' && mode !== 'size') {
    throw new Error(`unknown or missing mode "${mode ?? ''}"\n${USAGE}`);
  }
  let options: CliOptions = { mode, ...DEFAULT_OPTIONS };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`${flag ?? 'argument'} needs a value\n${USAGE}`);
    }
    switch (flag) {
      case '--variants': {
        const names = value.split(',').map((item) => item.trim());
        const unknown = names.find((name) => !isVariantName(name));
        if (unknown !== undefined) {
          throw new Error(`unknown variant "${unknown}" (one of ${VARIANT_NAMES.join(', ')})`);
        }
        options = { ...options, variants: names.filter(isVariantName) };
        break;
      }
      case '--counts':
        options = { ...options, counts: integerList(value, flag) };
        break;
      case '--throttles':
        options = { ...options, throttles: integerList(value, flag) };
        break;
      case '--duration':
        options = { ...options, durationMs: positiveInteger(value, flag) };
        break;
      case '--scale':
        options = { ...options, scale: positiveInteger(value, flag) };
        break;
      case '--chrome':
        options = { ...options, chrome: value };
        break;
      default:
        throw new Error(`unknown flag "${flag}"\n${USAGE}`);
    }
  }
  return options;
}

/** Usual install locations of Chrome and Chromium for the given platform, `CHROME_PATH` first. */
export function chromeCandidates(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const fromEnv = env['CHROME_PATH'];
  const explicit = fromEnv === undefined || fromEnv === '' ? [] : [fromEnv];
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      (root): root is string => root !== undefined && root !== '',
    );
    return [
      ...explicit,
      ...roots.map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`),
      ...roots.map((root) => `${root}\\Microsoft\\Edge\\Application\\msedge.exe`),
    ];
  }
  if (platform === 'darwin') {
    return [
      ...explicit,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    ...explicit,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

/** The first candidate that exists; throws with the list when none does. */
export function findChrome(
  candidates: readonly string[],
  exists: (path: string) => boolean,
): string {
  const found = candidates.find(exists);
  if (found === undefined) {
    throw new Error(
      `no Chrome found; set CHROME_PATH or pass --chrome (tried: ${candidates.join(', ')})`,
    );
  }
  return found;
}

export interface BenchRow {
  readonly variant: VariantName;
  readonly count: number;
  readonly throttle: number;
  /** Main thread busy share while idle apart from the variant, percent. */
  readonly busyPercent: number;
  /** Script, layout and style recalculation time per second of wall time, milliseconds. */
  readonly scriptMsPerSecond: number;
  readonly layouts: number;
  readonly styleRecalcs: number;
  readonly frames: FrameStats;
  readonly layoutShift: number;
  readonly longTasks: number;
  readonly animations: number;
}

/** Counter or duration of a `Performance.getMetrics` delta; a missing metric counts as 0. */
export function metric(delta: Metrics, name: string): number {
  return delta[name] ?? 0;
}

/** Condenses the browser counters of the idle pass (over `wallMs`) into the row fields. */
export function countersOf(
  delta: Metrics,
  wallMs: number,
): Pick<BenchRow, 'busyPercent' | 'scriptMsPerSecond' | 'layouts' | 'styleRecalcs'> {
  return {
    busyPercent: busyPercent(metric(delta, 'TaskDuration'), wallMs),
    scriptMsPerSecond: wallMs > 0 ? (metric(delta, 'ScriptDuration') * 1000 * 1000) / wallMs : 0,
    layouts: metric(delta, 'LayoutCount'),
    styleRecalcs: metric(delta, 'RecalcStyleCount'),
  };
}

const COLUMNS: readonly string[] = [
  'variant',
  'mascots',
  'CPU slowdown',
  'main busy %',
  'script ms/s',
  'layouts',
  'style recalcs',
  'fps',
  'p95 ms',
  'p99 ms',
  'max ms',
  'dropped',
  'CLS',
  'long tasks',
  'animations',
];

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** A GitHub-flavoured Markdown table of the rows. */
export function formatRows(rows: readonly BenchRow[]): string {
  const header = `| ${COLUMNS.join(' | ')} |`;
  const divider = `|${COLUMNS.map(() => '---').join('|')}|`;
  const lines = rows.map((row) =>
    [
      row.variant,
      String(row.count),
      `${String(row.throttle)}x`,
      fixed(row.busyPercent, 2),
      fixed(row.scriptMsPerSecond, 2),
      String(row.layouts),
      String(row.styleRecalcs),
      fixed(row.frames.fps, 1),
      fixed(row.frames.p95Ms, 1),
      fixed(row.frames.p99Ms, 1),
      fixed(row.frames.maxMs, 1),
      String(row.frames.dropped),
      fixed(row.layoutShift, 4),
      String(row.longTasks),
      String(row.animations),
    ].join(' | '),
  );
  return [header, divider, ...lines.map((line) => `| ${line} |`)].join('\n');
}

export interface SizeRow {
  readonly name: string;
  readonly minifiedBytes: number;
  readonly gzipBytes: number;
}

/** A Markdown table of bundle sizes. */
export function formatSizes(rows: readonly SizeRow[]): string {
  const lines = rows.map(
    (row) => `| ${row.name} | ${String(row.minifiedBytes)} | ${String(row.gzipBytes)} |`,
  );
  return ['| module | minified bytes | gzip bytes |', '|---|---|---|', ...lines].join('\n');
}
