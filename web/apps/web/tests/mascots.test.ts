import { describe, expect, it } from 'vitest';
import {
  integerScale,
  MASCOT_NAMES,
  MASCOT_SOURCES,
  MASCOTS,
  mascotSize,
  normaliseScale,
  resolveMascots,
} from '../src/ui/mascots.ts';
import { BOB_OFFSET_PX, BOB_PERIOD_MS, COMPACT_MAX_WIDTH_PX } from '../src/ui/motion.ts';
import { readAppFile, readRepoFile } from './helpers.ts';

const DESIGN = 'docs/design/prototypes';

describe('mascot catalogue', () => {
  it('lists nine mascots, each once, with unique source files', () => {
    expect(MASCOT_NAMES).toHaveLength(9);
    expect(new Set(MASCOT_NAMES).size).toBe(9);
    const files = MASCOT_NAMES.map((name) => MASCOT_SOURCES[name].file);
    expect(new Set(files).size).toBe(9);
  });

  it('matches the cast of the design reference (names and animals)', () => {
    const design = readRepoFile('docs/design/README.md');
    const names: Record<string, string> = {
      stuffy: 'Axolotl',
      mochi: 'Cream cat',
      hop: 'Frog',
      bun: 'Bunny',
      bloop: 'Jellyfish',
      waddle: 'Penguin',
      ember: 'Fox',
      boo: 'Ghost',
      cumulo: 'Cloud',
    };
    for (const name of MASCOT_NAMES) {
      const label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      expect(design, `${label} is not in the design README`).toMatch(
        new RegExp(`\\| ${names[name] ?? ''} \\| ${label} \\|`),
      );
    }
  });

  it.each(MASCOT_NAMES)('%s: the pixel grid equals the viewBox of its SVG file', (name) => {
    const source = MASCOT_SOURCES[name];
    const svg = readRepoFile(`${DESIGN}/${source.file}.svg`);
    expect(svg).toContain(`viewBox="0 0 ${String(source.cols)} ${String(source.rows)}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('resolves every mascot to an emitted SVG file url', () => {
    for (const name of MASCOT_NAMES) {
      const art = MASCOTS[name];
      expect(art.name).toBe(name);
      expect(art.url, `${name} has no svg url`).toMatch(/\.svg$/);
    }
    expect(new Set(MASCOT_NAMES.map((name) => MASCOTS[name].url)).size).toBe(9);
  });

  it('throws naming the mascot and file when an svg is missing', () => {
    const urls: Record<string, string> = {};
    for (const name of MASCOT_NAMES) {
      urls[`../../../../../${DESIGN}/${MASCOT_SOURCES[name].file}.svg`] = `/${name}.svg`;
    }
    expect(resolveMascots(urls).stuffy.url).toBe('/stuffy.svg');
    const ghostKey = `../../../../../${DESIGN}/mascot-ghost.svg`;
    const withoutGhost = Object.fromEntries(
      Object.entries(urls).filter(([key]) => key !== ghostKey),
    );
    expect(Object.keys(withoutGhost)).toHaveLength(8);
    expect(() => resolveMascots(withoutGhost)).toThrow(
      'mascot art for boo is missing: mascot-ghost.svg',
    );
  });
});

describe('integer scaling', () => {
  it.each([
    [1, 1],
    [1.9, 1],
    [2, 2],
    [16, 16],
    [16.99, 16],
  ])('normaliseScale(%s) is %s', (input, expected) => {
    expect(normaliseScale(input)).toBe(expected);
  });

  it('falls back to 1 below 1 and for values that are not numbers', () => {
    for (const bad of [
      0,
      0.99,
      -3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(normaliseScale(bad)).toBe(1);
    }
  });

  it('integerScale picks the largest whole scale that fits the width', () => {
    expect(integerScale(256, 16)).toBe(16);
    expect(integerScale(160, 16)).toBe(10);
    expect(integerScale(150, 16)).toBe(9);
    expect(integerScale(110, 16)).toBe(6);
    expect(integerScale(255, 16)).toBe(15);
    expect(integerScale(15, 16)).toBe(1);
  });

  it('integerScale never fails: bad widths or columns give 1', () => {
    expect(integerScale(Number.NaN, 16)).toBe(1);
    expect(integerScale(Number.POSITIVE_INFINITY, 16)).toBe(1);
    expect(integerScale(100, 0)).toBe(1);
    expect(integerScale(100, -4)).toBe(1);
  });

  it('mascotSize multiplies the grid by a whole scale', () => {
    expect(mascotSize({ cols: 16, rows: 11 }, 16)).toEqual({ width: 256, height: 176 });
    expect(mascotSize({ cols: 14, rows: 8 }, 3.7)).toEqual({ width: 42, height: 24 });
    expect(mascotSize({ cols: 12, rows: 12 }, 0)).toEqual({ width: 12, height: 12 });
  });

  it('keeps the design size of the main mascot: 256 px wide is 0.6875 of the width high', () => {
    const { width, height } = mascotSize(MASCOTS.stuffy, 16);
    expect(height / width).toBe(0.6875);
  });
});

describe('motion constants', () => {
  it('equal the bob of the design reference (stuff.css)', () => {
    const css = readRepoFile(`${DESIGN}/stuff.css`);
    expect(css).toContain(
      `@keyframes bob{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-${String(BOB_OFFSET_PX)}px)}}`,
    );
    expect(css).toContain(`.bob{animation:bob ${String(BOB_PERIOD_MS / 1000)}s steps(1) infinite}`);
    expect(css).toContain(`@media (max-width:${String(COMPACT_MAX_WIDTH_PX)}px)`);
  });

  it('are the numbers written in the component stylesheet', () => {
    const source = readAppFile('src/ui/Mascot.svelte');
    expect(source).toContain(`animation: bob ${String(BOB_PERIOD_MS / 1000)}s steps(1) infinite;`);
    expect(source).toContain(`transform: translateY(-${String(BOB_OFFSET_PX)}px);`);
    expect(source).toContain(`@media (max-width: ${String(COMPACT_MAX_WIDTH_PX)}px)`);
  });
});
