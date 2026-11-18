import { describe, expect, it } from 'vitest';
import { readAppFile, readCustomProperties, readRepoFile, readRepoFiles } from './helpers.ts';
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
// they sit on. The thin hairlines (--line, --line2) only divide the layout (or frame a card
// or a labelled button) and are not listed: the design carries meaning in text and in these
// indicators. The border of a text field is the one hairline that identifies a control, so
// it has its own token (--field-border, SF8) and its own section below.
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

// Field borders (1.4.11): the border of an input, select or textarea must reach 3:1 against
// every surface a field can sit on (the page, a raised surface, a checked/dragged-over one, a code block).
const fieldSurfaces: readonly (readonly [surface: string, where: string])[] = [
  ['--bg', 'page, dialog and card'],
  ['--bg-raised', 'raised surface'],
  ['--bg-selected', 'selected surface'],
  ['--bg-code', 'code block surface'],
];

describe('field border contrast (WCAG 2.2 AA 1.4.11, 3:1)', () => {
  it.each(fieldSurfaces)('--field-border on %s (%s)', (surface) => {
    expect(ratio('--field-border', surface)).toBeGreaterThanOrEqual(3);
  });

  it('is clearly stronger than the hairline it replaced on fields', () => {
    expect(ratio('--field-border', '--bg')).toBeGreaterThan(ratio('--line2', '--bg') * 2);
  });
});

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]]/g, String.raw`\$&`);
  const match = new RegExp(String.raw`(?:^|\})\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(css);
  if (match?.[1] === undefined) {
    throw new Error(`no rule for ${selector}`);
  }
  return match[1];
}

describe('field borders use the token', () => {
  it('draws the border of every Input and Select with --field-border', () => {
    const body = ruleBody(readAppFile('src/ui/field.css'), '.sc-field');
    expect(body).toMatch(/border:\s*1px solid var\(--field-border\)/);
    expect(body).not.toMatch(/--line/);
  });

  it('draws the border of the design source .field with --field-border', () => {
    const body = ruleBody(readRepoFile('docs/design/prototypes/stuff.css'), '.field');
    expect(body).toMatch(/border:1px solid var\(--field-border\)/);
  });

  it('keeps hairline colours off the form controls of every mockup', () => {
    const hairline = /<(?:input|select|textarea)\b[^>]*border:\s*1px solid #3a3a42[^>]*>/i;
    const offenders = readRepoFiles('docs/design/prototypes', '.html').filter((html) =>
      hairline.test(html),
    );
    expect(offenders).toHaveLength(0);
  });

  it('has a helper that finds nothing in a stylesheet without the rule', () => {
    expect(() => ruleBody('.other { color: red }', '.sc-field')).toThrow('no rule for .sc-field');
    expect(ruleBody('a { x: 1 } .sc-field { border: 0 }', '.sc-field')).toBe(' border: 0 ');
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
