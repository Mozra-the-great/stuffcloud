import { describe, expect, it } from 'vitest';
import { buildSpriteSheet, svgInner } from '../bench/sheet.ts';
import {
  busyPercent,
  DROPPED_FRAME_FACTOR,
  FRAME_BUDGET_MS,
  frameStats,
  intervalsOf,
  layoutShiftTotal,
  metricsDelta,
  percentile,
} from '../bench/stats.ts';

describe('percentile', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses the nearest rank', () => {
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 10)).toBe(1);
    expect(percentile(sorted, 11)).toBe(2);
  });

  it('clamps p to the range and handles the ends', () => {
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, -20)).toBe(1);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, 250)).toBe(10);
  });

  it('is 0 for an empty list and the value for one element', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 1)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });
});

describe('frameStats', () => {
  it('is all zeros without frames', () => {
    expect(frameStats([])).toEqual({
      frames: 0,
      fps: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      dropped: 0,
    });
  });

  it('computes fps, percentiles and the maximum, whatever the input order', () => {
    const stats = frameStats([20, 10, 10, 10]);
    expect(stats.frames).toBe(4);
    expect(stats.fps).toBeCloseTo(4 / 0.05, 10);
    expect(stats.medianMs).toBe(10);
    expect(stats.p95Ms).toBe(20);
    expect(stats.p99Ms).toBe(20);
    expect(stats.maxMs).toBe(20);
  });

  it('does not change the input', () => {
    const input = [3, 1, 2];
    frameStats(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('counts a frame as dropped only above 1.5 budgets', () => {
    const limit = FRAME_BUDGET_MS * DROPPED_FRAME_FACTOR;
    expect(frameStats([limit]).dropped).toBe(0);
    expect(frameStats([limit + 0.01]).dropped).toBe(1);
    expect(frameStats([FRAME_BUDGET_MS, 50, 33.4, 16]).dropped).toBe(2);
  });

  it('honours a custom budget', () => {
    expect(frameStats([10, 20], 5).dropped).toBe(2);
    expect(frameStats([10, 20], 10).dropped).toBe(1);
  });

  it('has 0 fps when all intervals are 0', () => {
    expect(frameStats([0, 0]).fps).toBe(0);
  });
});

describe('intervalsOf', () => {
  it('turns timestamps into differences', () => {
    expect(intervalsOf([0, 16, 33, 50])).toEqual([16, 17, 17]);
  });

  it('is empty for fewer than two timestamps', () => {
    expect(intervalsOf([])).toEqual([]);
    expect(intervalsOf([5])).toEqual([]);
  });
});

describe('layoutShiftTotal', () => {
  it('sums shifts and ignores those right after input', () => {
    expect(layoutShiftTotal([])).toBe(0);
    expect(
      layoutShiftTotal([
        { value: 0.1, hadRecentInput: false },
        { value: 0.25, hadRecentInput: true },
        { value: 0.05, hadRecentInput: false },
      ]),
    ).toBeCloseTo(0.15, 10);
  });
});

describe('metricsDelta', () => {
  it('subtracts per metric and drops metrics missing at the start', () => {
    expect(metricsDelta({ a: 1, b: 5 }, { a: 4, b: 5, c: 9 })).toEqual({ a: 3, b: 0 });
    expect(metricsDelta({}, { a: 1 })).toEqual({});
  });
});

describe('busyPercent', () => {
  it('is the busy share of the wall time', () => {
    expect(busyPercent(0.5, 1000)).toBe(50);
    expect(busyPercent(0.02, 4000)).toBeCloseTo(0.5, 10);
  });

  it('is 0 without wall time', () => {
    expect(busyPercent(1, 0)).toBe(0);
    expect(busyPercent(1, -5)).toBe(0);
  });
});

describe('sprite sheet', () => {
  const art =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h1v1h-1z"/></svg>';

  it('extracts the content between the outer svg tags', () => {
    expect(svgInner(art)).toBe('<path fill="#fff" d="M0 0h1v1h-1z"/>');
    expect(svgInner(`\n${art}\n`)).toBe('<path fill="#fff" d="M0 0h1v1h-1z"/>');
  });

  it('rejects anything that is not one svg document', () => {
    expect(() => svgInner('<div></div>')).toThrow('not an SVG document');
    expect(() => svgInner('')).toThrow('not an SVG document');
    expect(() => svgInner('<svg></svg> trailing')).toThrow('not an SVG document');
  });

  it('stacks the rest pose and the raised pose with one row of headroom each', () => {
    const sheet = buildSpriteSheet(art, 4, 3, 0.25);
    expect(sheet.frameRows).toBe(4);
    expect(sheet.svg).toContain('viewBox="0 0 4 8"');
    expect(sheet.svg).toContain('shape-rendering="crispEdges"');
    expect(sheet.svg).toContain('<g transform="translate(0 1)"><path');
    // second frame starts at row 4; raised by 0.25 art pixels from the rest position (4 + 1 - 0.25)
    expect(sheet.svg).toContain('<g transform="translate(0 4.75)"><path');
    expect(sheet.svg.match(/<path /g)).toHaveLength(2);
  });

  it('raises the second pose by the given amount only', () => {
    expect(buildSpriteSheet(art, 4, 3, 0).svg).toContain('translate(0 5)');
    expect(buildSpriteSheet(art, 4, 3, 1).svg).toContain('translate(0 4)');
  });
});
