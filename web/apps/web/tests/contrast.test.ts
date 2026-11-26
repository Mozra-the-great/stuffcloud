import { describe, expect, it } from 'vitest';
import { readCustomProperties, readKernCodeTokens } from './helpers.ts';
import { contrastRatio, parseHex, relativeLuminance } from './contrast.ts';

// The values the app ships: kern's Code theme (<html data-theme="code">, dark), plus the few
// app-local tokens (`--sc-*`, each waiting for a kern issue). kern's own theme contrast test
// covers every theme with its own pair list; this one tests the pairs *stuffcloud draws*, so a
// kern bump that weakens one of them fails here, never silently in the app.
const tokens = new Map([...readKernCodeTokens(), ...readCustomProperties('src/styles/theme.css')]);

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

// Text pairs actually drawn by the components, WCAG 2.2 AA (1.4.3): 4.5:1.
// Disabled controls are exempt (1.4.3), so --k-fg-disabled is deliberately not listed.
const textPairs: readonly (readonly [foreground: string, background: string, where: string])[] = [
  ['--k-fg', '--k-bg', 'body text'],
  ['--k-fg', '--k-bg-raised', 'current tab, hovered tile, toast'],
  ['--k-fg', '--k-surface-selected', 'dragged-over dropzone'],
  ['--k-fg', '--k-surface-danger', 'error toast'],
  ['--k-fg', '--k-surface-warn', 'warning toast'],
  ['--k-fg-muted', '--k-bg', 'labels, hints, placeholders'],
  ['--k-fg-muted', '--k-bg-raised', 'labels on raised surfaces'],
  ['--k-fg-soft', '--k-bg', 'long copy'],
  ['--k-fg-code', '--k-bg-code', 'code block'],
  ['--k-fg-hint', '--k-bg', 'dropzone hint'],
  ['--k-fg-hint', '--k-surface-selected', 'dropzone hint while dragging'],
  ['--k-link', '--k-bg', 'links and addresses'],
  ['--k-accent', '--k-bg', 'link hover'],
  ['--k-accent', '--k-bg-raised', 'tab hover on a raised surface'],
  ['--k-danger', '--k-bg', 'field error text'],
  ['--k-ok', '--k-bg-code', 'copied status'],
  ['--k-bg', '--k-fg', 'primary button'],
  ['--k-bg', '--k-accent', 'button hover'],
  ['--k-bg', '--k-danger', 'danger button'],
];

describe('text contrast (WCAG 2.2 AA, 4.5:1)', () => {
  it.each(textPairs)('%s on %s (%s)', (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

// Non-text contrast (1.4.11): indicators and focus rings must reach 3:1 against the surface
// they sit on. The thin hairlines (--k-line, --k-line-strong) only divide the layout (or frame a card
// or a labelled button) and are not listed: the UI carries meaning in text and in these
// indicators. The border of a text field is the one hairline that identifies a control, so
// it has its own token (--k-border, SF8) and its own section below.
const indicatorPairs: readonly (readonly [colour: string, surface: string, where: string])[] = [
  ['--k-fg', '--k-bg', 'focus ring'],
  ['--k-accent', '--k-bg', 'selected tab underline, dragged-over border'],
  ['--k-accent', '--k-bg-raised', 'selected tab underline on its raised surface'],
  ['--k-danger', '--k-bg', 'invalid field border'],
  ['--k-ok', '--k-bg', 'success status'],
  ['--k-warn', '--k-bg', 'warning status and full bar'],
  ['--k-accent', '--k-line', 'progress fill on its track'],
  ['--k-warn', '--k-line', 'warning progress fill on its track'],
];

describe('indicator contrast (WCAG 2.2 AA, 3:1)', () => {
  it.each(indicatorPairs)('%s on %s (%s)', (indicator, surface) => {
    expect(ratio(indicator, surface)).toBeGreaterThanOrEqual(3);
  });
});

// Field borders (1.4.11): the border of an input, select or textarea must reach 3:1 against
// every surface a field can sit on (the page, a raised surface, a checked/dragged-over one, a code block).
const fieldSurfaces: readonly (readonly [surface: string, where: string])[] = [
  ['--k-bg', 'page, dialog and card'],
  ['--k-bg-raised', 'raised surface'],
  ['--k-surface-selected', 'selected surface'],
  ['--k-bg-code', 'code block surface'],
];

describe('field border contrast (WCAG 2.2 AA 1.4.11, 3:1)', () => {
  it.each(fieldSurfaces)('--k-border on %s (%s)', (surface) => {
    expect(ratio('--k-border', surface)).toBeGreaterThanOrEqual(3);
  });

  it('is clearly stronger than the hairline between cells', () => {
    expect(ratio('--k-border', '--k-bg')).toBeGreaterThan(ratio('--k-line-strong', '--k-bg') * 2);
  });
});

describe('contrast guard', () => {
  it('fails on a pair that is too weak', () => {
    expect(ratio('--k-line-strong', '--k-bg')).toBeLessThan(3);
  });

  it('refuses a token that is not a colour', () => {
    expect(() => colour('--k-font-mono')).toThrow('--k-font-mono is not a hex colour token');
    expect(() => colour('--k-missing')).toThrow('--k-missing is not a hex colour token');
  });
});
