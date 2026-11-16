import { describe, expect, it } from 'vitest';
import {
  chromeCandidates,
  countersOf,
  DEFAULT_OPTIONS,
  findChrome,
  formatRows,
  formatSizes,
  metric,
  parseArgs,
  type BenchRow,
} from '../bench/report.ts';

describe('parseArgs', () => {
  it('takes the mode and falls back to the defaults', () => {
    for (const mode of ['bench', 'verify', 'size'] as const) {
      expect(parseArgs([mode])).toEqual({ mode, ...DEFAULT_OPTIONS });
    }
    expect(DEFAULT_OPTIONS.variants).toHaveLength(6);
  });

  it('reads every flag', () => {
    expect(
      parseArgs([
        'bench',
        '--variants',
        'css-transform, canvas-raf',
        '--counts',
        '1,8',
        '--throttles',
        '4',
        '--duration',
        '2500',
        '--scale',
        '8',
        '--chrome',
        '/opt/chrome',
      ]),
    ).toEqual({
      mode: 'bench',
      variants: ['css-transform', 'canvas-raf'],
      counts: [1, 8],
      throttles: [4],
      durationMs: 2500,
      scale: 8,
      chrome: '/opt/chrome',
    });
  });

  it('rejects a missing or unknown mode with the usage', () => {
    expect(() => parseArgs([])).toThrow(/unknown or missing mode ""\nusage:/);
    expect(() => parseArgs(['run'])).toThrow('unknown or missing mode "run"');
  });

  it('rejects an unknown flag, a flag without value and an unknown variant', () => {
    expect(() => parseArgs(['bench', '--speed', '1'])).toThrow('unknown flag "--speed"');
    expect(() => parseArgs(['bench', '--counts'])).toThrow('--counts needs a value');
    expect(() => parseArgs(['bench', '--variants', 'static,gif'])).toThrow(
      'unknown variant "gif" (one of static, css-transform',
    );
  });

  it('rejects numbers that are not positive whole numbers', () => {
    for (const bad of ['0', '-1', '1.5', 'x', '']) {
      expect(() => parseArgs(['bench', '--duration', bad])).toThrow(
        `--duration needs positive whole numbers, got "${bad}"`,
      );
    }
    expect(() => parseArgs(['bench', '--counts', '1,0'])).toThrow('--counts needs positive');
    expect(() => parseArgs(['bench', '--scale', '2.5'])).toThrow('--scale needs positive');
  });
});

describe('chromeCandidates', () => {
  it('puts CHROME_PATH first and ignores an empty one', () => {
    expect(chromeCandidates('linux', { CHROME_PATH: '/x/chrome' })[0]).toBe('/x/chrome');
    expect(chromeCandidates('linux', { CHROME_PATH: '' })[0]).toBe('/usr/bin/google-chrome');
    expect(chromeCandidates('linux', {})).toContain('/usr/bin/chromium');
  });

  it('lists the Windows install roots that exist in the environment', () => {
    const list = chromeCandidates('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      'PROGRAMFILES(X86)': '',
    });
    expect(list).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(list).toContain('C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    expect(list).toContain('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(list.some((path) => path.startsWith('\\'))).toBe(false);
    expect(chromeCandidates('win32', {})).toEqual([]);
  });

  it('knows the macOS bundles', () => {
    expect(chromeCandidates('darwin', {})[0]).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  });
});

describe('findChrome', () => {
  it('returns the first candidate that exists', () => {
    expect(findChrome(['/a', '/b', '/c'], (path) => path !== '/a')).toBe('/b');
  });

  it('throws listing what it tried', () => {
    expect(() => findChrome(['/a', '/b'], () => false)).toThrow(
      'no Chrome found; set CHROME_PATH or pass --chrome (tried: /a, /b)',
    );
  });
});

describe('countersOf', () => {
  it('turns browser counters into per-second figures', () => {
    expect(
      countersOf(
        { TaskDuration: 0.04, ScriptDuration: 0.008, LayoutCount: 2, RecalcStyleCount: 5 },
        4000,
      ),
    ).toEqual({ busyPercent: 1, scriptMsPerSecond: 2, layouts: 2, styleRecalcs: 5 });
  });

  it('treats missing metrics as 0 and a zero wall time as no load', () => {
    expect(countersOf({}, 1000)).toEqual({
      busyPercent: 0,
      scriptMsPerSecond: 0,
      layouts: 0,
      styleRecalcs: 0,
    });
    expect(countersOf({ TaskDuration: 1, ScriptDuration: 1 }, 0)).toMatchObject({
      busyPercent: 0,
      scriptMsPerSecond: 0,
    });
    expect(metric({ a: 2 }, 'a')).toBe(2);
    expect(metric({ a: 2 }, 'b')).toBe(0);
  });
});

describe('tables', () => {
  const row: BenchRow = {
    variant: 'css-transform',
    count: 64,
    throttle: 6,
    busyPercent: 1.234,
    scriptMsPerSecond: 0.456,
    layouts: 0,
    styleRecalcs: 4,
    frames: {
      frames: 100,
      fps: 143.96,
      medianMs: 6.9,
      p95Ms: 7.14,
      p99Ms: 8,
      maxMs: 9.9,
      dropped: 1,
    },
    layoutShift: 0,
    longTasks: 0,
    animations: 64,
  };

  it('formats a Markdown table with header, divider and one line per row', () => {
    const lines = formatRows([row, { ...row, variant: 'static' }]).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\| variant \| mascots \| CPU slowdown \|/);
    expect(lines[1]).toBe(`|${'---|'.repeat(15)}`);
    expect(lines[2]).toBe(
      '| css-transform | 64 | 6x | 1.23 | 0.46 | 0 | 4 | 144.0 | 7.1 | 8.0 | 9.9 | 1 | 0.0000 | 0 | 64 |',
    );
    expect(lines[3]).toContain('| static | 64 |');
  });

  it('has as many cells as columns', () => {
    const [header, , line] = formatRows([row]).split('\n');
    expect(line?.split(' | ')).toHaveLength(header?.split(' | ').length ?? -1);
  });

  it('formats sizes', () => {
    expect(formatSizes([{ name: 'a', minifiedBytes: 10, gzipBytes: 7 }])).toBe(
      '| module | minified bytes | gzip bytes |\n|---|---|---|\n| a | 10 | 7 |',
    );
  });
});
