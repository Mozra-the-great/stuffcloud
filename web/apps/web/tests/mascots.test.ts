import { render } from '@testing-library/svelte';
import {
  BOB_OFFSET_PX,
  BOB_PERIOD_MS,
  COMPACT_MAX_WIDTH_PX,
  Mascot,
  MASCOT_NAMES,
  MASCOT_SOURCES,
} from '@mozra-the-great/kern';
import { describe, expect, it } from 'vitest';
import { MASCOT_URLS, resolveMascotUrls } from '../src/app/mascots.ts';
import { readRepoFile } from './helpers.ts';

// kern owns the component, the cast and the motion (its tests: kern docs/testing.md, rows
// `mascot` and `mascots`); the art stays in docs/design. These tests keep the two in step.
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

  it.each(MASCOT_NAMES)("%s: kern's pixel grid equals the viewBox of the design's SVG", (name) => {
    const source = MASCOT_SOURCES[name];
    const svg = readRepoFile(`${DESIGN}/${source.file}.svg`);
    expect(svg).toContain(`viewBox="0 0 ${String(source.cols)} ${String(source.rows)}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('resolves every mascot to an emitted SVG file url', () => {
    for (const name of MASCOT_NAMES) {
      expect(MASCOT_URLS[name], `${name} has no svg url`).toMatch(/\.svg$/);
    }
    expect(new Set(MASCOT_NAMES.map((name) => MASCOT_URLS[name])).size).toBe(9);
  });

  it('throws naming the mascot and file when an svg is missing', () => {
    const urls: Record<string, string> = {};
    for (const name of MASCOT_NAMES) {
      urls[`../../../../../${DESIGN}/${MASCOT_SOURCES[name].file}.svg`] = `/${name}.svg`;
    }
    expect(resolveMascotUrls(urls).stuffy).toBe('/stuffy.svg');
    const ghostKey = `../../../../../${DESIGN}/mascot-ghost.svg`;
    const withoutGhost = Object.fromEntries(
      Object.entries(urls).filter(([key]) => key !== ghostKey),
    );
    expect(Object.keys(withoutGhost)).toHaveLength(8);
    expect(() => resolveMascotUrls(withoutGhost)).toThrow(
      'mascot art for boo is missing: mascot-ghost.svg',
    );
  });
});

describe('kern Mascot with the design art', () => {
  it.each(MASCOT_NAMES)('%s draws the design file at a whole scale, decoratively', (name) => {
    const { container } = render(Mascot, { name, src: MASCOT_URLS[name], scale: 6 });
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(MASCOT_URLS[name]);
    expect(image?.getAttribute('width')).toBe(String(MASCOT_SOURCES[name].cols * 6));
    expect(image?.getAttribute('height')).toBe(String(MASCOT_SOURCES[name].rows * 6));
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent.trim()).toBe('');
  });
});

describe('motion constants', () => {
  it("kern's bob equals the design reference (stuff.css)", () => {
    const css = readRepoFile(`${DESIGN}/stuff.css`);
    expect(css).toContain(
      `@keyframes bob{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-${String(BOB_OFFSET_PX)}px)}}`,
    );
    expect(css).toContain(`.bob{animation:bob ${String(BOB_PERIOD_MS / 1000)}s steps(1) infinite}`);
    expect(css).toContain(`@media (max-width:${String(COMPACT_MAX_WIDTH_PX)}px)`);
  });
});
