import { describe, expect, it } from 'vitest';
import { readCustomProperties } from './helpers.ts';
import { contrastRatio, parseHex, relativeLuminance } from './contrast.ts';

const tokens = readCustomProperties('src/styles/tokens.css', 'src/styles/theme.css');

function colour(name: string): string {
  const value = tokens.get(name);
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} is not a hex colour token`);
  }
  return value;
}

function ratio(foreground: string, background: string): number {
  return contrastRatio(colour(foreground), colour(background));
}

describe('contrast helpers', () => {
  it('parses six-digit hex colours', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0]);
    expect(parseHex('#FFFFFF')).toEqual([255, 255, 255]);
  });

  it('rejects anything else', () => {
    expect(() => parseHex('#fff')).toThrow('not a six-digit hex colour: #fff');
    expect(() => parseHex('red')).toThrow('not a six-digit hex colour: red');
  });

  it('computes the WCAG relative luminance at the extremes', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
    // Below and above the sRGB linearisation knee (0.03928).
    expect(relativeLuminance([10, 10, 10])).toBeCloseTo(10 / 255 / 12.92, 10);
    expect(relativeLuminance([128, 128, 128])).toBeCloseTo(0.2159, 4);
  });

  it('matches the WCAG reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

// Text pairs actually drawn by the components and the mockups, WCAG 2.2 AA (1.4.3): 4.5:1.
// Disabled controls are exempt (1.4.3), so --fg-disabled is deliberately not listed.
const textPairs: readonly (readonly [foreground: string, background: string, where: string])[] = [
  ['--fg', '--bg', 'body text'],
  ['--fg', '--bg-raised', 'current tab, hovered tile, toast'],
  ['--fg', '--bg-selected', 'dragged-over dropzone'],
  ['--fg', '--bg-error', 'error toast'],
  ['--fg', '--bg-warn', 'warning toast'],
  ['--mut', '--bg', 'labels, hints, placeholders'],
  ['--mut', '--bg-raised', 'labels on raised surfaces'],
  ['--fg-soft', '--bg', 'long copy'],
  ['--fg-code', '--bg-code', 'code block'],
  ['--fg-hint', '--bg', 'dropzone hint'],
  ['--fg-hint', '--bg-selected', 'dropzone hint while dragging'],
  ['--lilac', '--bg', 'links and addresses'],
  ['--pink', '--bg', 'link hover'],
  ['--pink', '--bg-raised', 'tab hover on a raised surface'],
  ['--pink2', '--bg', 'field error text'],
  ['--green', '--bg-code', 'copied status'],
  ['--bg', '--fg', 'primary button'],
  ['--bg', '--pink', 'button hover'],
  ['--bg', '--pink2', 'danger button'],
];

describe('text contrast (WCAG 2.2 AA, 4.5:1)', () => {
  it.each(textPairs)('%s on %s (%s)', (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

// Non-text contrast (1.4.11): indicators and focus rings must reach 3:1 against the surface
// they sit on. The thin hairlines (--line, --line2) only divide the layout and are not
// listed: the design carries meaning in text and in these indicators.
const indicatorPairs: readonly (readonly [colour: string, surface: string, where: string])[] = [
  ['--fg', '--bg', 'focus ring'],
  ['--pink', '--bg', 'selected tab underline, dragged-over border'],
  ['--pink', '--bg-raised', 'selected tab underline on its raised surface'],
  ['--pink2', '--bg', 'invalid field border'],
  ['--green', '--bg', 'success status'],
  ['--amber', '--bg', 'warning status and full bar'],
  ['--pink', '--line', 'progress fill on its track'],
  ['--amber', '--line', 'warning progress fill on its track'],
];

describe('indicator contrast (WCAG 2.2 AA, 3:1)', () => {
  it.each(indicatorPairs)('%s on %s (%s)', (indicator, surface) => {
    expect(ratio(indicator, surface)).toBeGreaterThanOrEqual(3);
  });
});

describe('contrast guard', () => {
  it('fails on a pair that is too weak', () => {
    expect(ratio('--line2', '--bg')).toBeLessThan(3);
  });

  it('refuses a token that is not a colour', () => {
    expect(() => colour('--mono')).toThrow('--mono is not a hex colour token');
    expect(() => colour('--missing')).toThrow('--missing is not a hex colour token');
  });
});
