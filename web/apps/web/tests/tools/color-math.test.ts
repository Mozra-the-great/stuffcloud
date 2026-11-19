import { describe, expect, it } from 'vitest';
import {
  checkContrast,
  cmykToRgb,
  contrastRatio,
  formatAll,
  formatCmyk,
  formatHex,
  formatHsl,
  formatNumber,
  formatOklch,
  formatRatio,
  formatRgb,
  hslToRgb,
  oklchToRgb,
  parseColor,
  relativeLuminance,
  rgbFromPicker,
  rgbToCmyk,
  rgbToHsl,
  rgbToOklch,
  type ColorErrorCode,
  type Rgb,
} from '../../src/tools/color/color.ts';

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

/** Reference colours: [name, rgb, hex, hsl text, oklch text, cmyk text]. */
const REFERENCE: readonly (readonly [string, Rgb, string, string, string, string])[] = [
  ['black', rgb(0, 0, 0), '#000000', 'hsl(0, 0%, 0%)', 'oklch(0% 0 0)', 'cmyk(0%, 0%, 0%, 100%)'],
  [
    'white',
    rgb(255, 255, 255),
    '#ffffff',
    'hsl(0, 0%, 100%)',
    'oklch(100% 0 0)',
    'cmyk(0%, 0%, 0%, 0%)',
  ],
  [
    'red',
    rgb(255, 0, 0),
    '#ff0000',
    'hsl(0, 100%, 50%)',
    'oklch(62.8% 0.2577 29.23)',
    'cmyk(0%, 100%, 100%, 0%)',
  ],
  [
    'lime',
    rgb(0, 255, 0),
    '#00ff00',
    'hsl(120, 100%, 50%)',
    'oklch(86.64% 0.2948 142.5)',
    'cmyk(100%, 0%, 100%, 0%)',
  ],
  [
    'blue',
    rgb(0, 0, 255),
    '#0000ff',
    'hsl(240, 100%, 50%)',
    'oklch(45.2% 0.3132 264.05)',
    'cmyk(100%, 100%, 0%, 0%)',
  ],
  [
    'grey',
    rgb(128, 128, 128),
    '#808080',
    'hsl(0, 0%, 50.2%)',
    'oklch(59.99% 0 0)',
    'cmyk(0%, 0%, 0%, 49.8%)',
  ],
];

describe('formatting', () => {
  it.each(REFERENCE)('writes %s in all five formats', (_name, color, hex, hsl, oklch, cmyk) => {
    expect(formatHex(color)).toBe(hex);
    expect(formatRgb(color)).toBe(
      `rgb(${String(color.r)}, ${String(color.g)}, ${String(color.b)})`,
    );
    expect(formatHsl(color)).toBe(hsl);
    expect(formatOklch(color)).toBe(oklch);
    expect(formatCmyk(color)).toBe(cmyk);
  });

  it('lists the formats in display order with their labels', () => {
    expect(formatAll(rgb(255, 0, 0)).map((entry) => [entry.format, entry.label])).toEqual([
      ['hex', 'HEX'],
      ['rgb', 'RGB'],
      ['hsl', 'HSL'],
      ['oklch', 'OKLCH'],
      ['cmyk', 'CMYK'],
    ]);
    expect(formatAll(rgb(1, 2, 3))[0]?.value).toBe('#010203');
  });

  it('pads single-digit hex channels', () => {
    expect(formatHex(rgb(0, 10, 255))).toBe('#000aff');
  });

  it('formats numbers with at most the given places and no trailing zeros', () => {
    expect(formatNumber(1.5, 1)).toBe('1.5');
    expect(formatNumber(1.25, 1)).toBe('1.3');
    expect(formatNumber(2, 3)).toBe('2');
    expect(formatNumber(0.00004, 3)).toBe('0');
    expect(formatNumber(-0.0001, 2)).toBe('0');
  });
});

describe('conversions', () => {
  it('converts pure and mixed colours between RGB and HSL', () => {
    expect(rgbToHsl(rgb(255, 0, 0))).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl(rgb(0, 0, 255)).h).toBeCloseTo(240, 9);
    expect(rgbToHsl(rgb(255, 0, 128)).h).toBeCloseTo(329.9, 1);
    expect(hslToRgb({ h: 0, s: 100, l: 50 })).toEqual(rgb(255, 0, 0));
    expect(hslToRgb({ h: 120, s: 100, l: 50 })).toEqual(rgb(0, 255, 0));
    expect(hslToRgb({ h: 240, s: 100, l: 50 })).toEqual(rgb(0, 0, 255));
    expect(hslToRgb({ h: 60, s: 100, l: 50 })).toEqual(rgb(255, 255, 0));
    expect(hslToRgb({ h: 180, s: 100, l: 50 })).toEqual(rgb(0, 255, 255));
    expect(hslToRgb({ h: 300, s: 100, l: 50 })).toEqual(rgb(255, 0, 255));
  });

  it('wraps hues: -120, 360 and 480 are valid', () => {
    expect(hslToRgb({ h: -120, s: 100, l: 50 })).toEqual(rgb(0, 0, 255));
    expect(hslToRgb({ h: 360, s: 100, l: 50 })).toEqual(rgb(255, 0, 0));
    expect(hslToRgb({ h: 480, s: 100, l: 50 })).toEqual(rgb(0, 255, 0));
  });

  it('keeps greys grey and gives them hue 0', () => {
    expect(rgbToHsl(rgb(77, 77, 77)).h).toBe(0);
    expect(rgbToHsl(rgb(77, 77, 77)).s).toBe(0);
    expect(rgbToOklch(rgb(77, 77, 77))).toMatchObject({ c: 0, h: 0 });
  });

  it('converts CMYK both ways, including pure black', () => {
    expect(rgbToCmyk(rgb(0, 0, 0))).toEqual({ c: 0, m: 0, y: 0, k: 100 });
    expect(cmykToRgb({ c: 0, m: 0, y: 0, k: 100 })).toEqual(rgb(0, 0, 0));
    expect(cmykToRgb({ c: 0, m: 100, y: 100, k: 0 })).toEqual(rgb(255, 0, 0));
    expect(cmykToRgb({ c: 100, m: 0, y: 0, k: 50 })).toEqual(rgb(0, 128, 128));
    expect(rgbToCmyk(rgb(255, 128, 0))).toMatchObject({ c: 0, k: 0 });
  });

  it('converts to OKLCH like CSS Color 4 (reference values)', () => {
    const red = rgbToOklch(rgb(255, 0, 0));
    expect(red.l).toBeCloseTo(0.62796, 4);
    expect(red.c).toBeCloseTo(0.25768, 4);
    expect(red.h).toBeCloseTo(29.234, 2);
    const white = rgbToOklch(rgb(255, 255, 255));
    expect(white.l).toBeCloseTo(1, 5);
    expect(white.c).toBe(0);
  });

  it('round-trips all greys and a coarse grid through every format', () => {
    for (let value = 0; value <= 255; value += 1) {
      const grey = rgb(value, value, value);
      expect(hslToRgb(rgbToHsl(grey))).toEqual(grey);
      expect(cmykToRgb(rgbToCmyk(grey))).toEqual(grey);
      const back = oklchToRgb(rgbToOklch(grey));
      expect(back.inGamut).toBe(true);
      expect(back.rgb).toEqual(grey);
    }
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const color = rgb(r, g, b);
          expect(hslToRgb(rgbToHsl(color))).toEqual(color);
          expect(cmykToRgb(rgbToCmyk(color))).toEqual(color);
          const { rgb: back, inGamut } = oklchToRgb(rgbToOklch(color));
          expect(back).toEqual(color);
          expect(inGamut).toBe(true);
        }
      }
    }
  });

  it('parses back what it formats, within one step per channel (rounded display)', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % 256;
    };
    for (let index = 0; index < 500; index += 1) {
      const color = rgb(next(), next(), next());
      for (const entry of formatAll(color)) {
        const parsed = parseColor(entry.value);
        expect(parsed.ok, entry.value).toBe(true);
        if (parsed.ok) {
          expect(parsed.format).toBe(entry.format);
          expect(Math.abs(parsed.rgb.r - color.r), entry.value).toBeLessThanOrEqual(1);
          expect(Math.abs(parsed.rgb.g - color.g), entry.value).toBeLessThanOrEqual(1);
          expect(Math.abs(parsed.rgb.b - color.b), entry.value).toBeLessThanOrEqual(1);
        }
      }
      expect(parseColor(formatHex(color))).toMatchObject({ ok: true, rgb: color });
    }
  });
});

describe('OKLCH gamut', () => {
  it('reduces the chroma of a colour outside sRGB and says so', () => {
    const result = oklchToRgb({ l: 0.7, c: 0.4, h: 150 });
    expect(result.inGamut).toBe(false);
    const again = rgbToOklch(result.rgb);
    expect(again.c).toBeLessThan(0.4);
    expect(again.l).toBeCloseTo(0.7, 1);
    expect(Math.abs(again.h - 150)).toBeLessThan(5);
  });

  it('keeps the exact edges: black and white are in gamut only without chroma', () => {
    expect(oklchToRgb({ l: 0, c: 0, h: 0 })).toEqual({ rgb: rgb(0, 0, 0), inGamut: true });
    expect(oklchToRgb({ l: 1, c: 0, h: 0 })).toEqual({ rgb: rgb(255, 255, 255), inGamut: true });
    expect(oklchToRgb({ l: 0, c: 0.2, h: 0 })).toEqual({ rgb: rgb(0, 0, 0), inGamut: false });
    expect(oklchToRgb({ l: 1, c: 0.2, h: 0 })).toEqual({
      rgb: rgb(255, 255, 255),
      inGamut: false,
    });
  });

  it('clamps a lightness above 1 or below 0', () => {
    expect(oklchToRgb({ l: 1.5, c: 0, h: 0 }).rgb).toEqual(rgb(255, 255, 255));
    expect(oklchToRgb({ l: -1, c: 0, h: 0 }).rgb).toEqual(rgb(0, 0, 0));
  });
});

describe('parseColor: accepted input', () => {
  it.each([
    ['#f00', rgb(255, 0, 0), 'hex'],
    ['f00', rgb(255, 0, 0), 'hex'],
    ['#FF0000', rgb(255, 0, 0), 'hex'],
    ['  #00ff00  ', rgb(0, 255, 0), 'hex'],
    ['#0000ffff', rgb(0, 0, 255), 'hex'],
    ['#00fF', rgb(0, 0, 255), 'hex'],
    ['rgb(255, 0, 0)', rgb(255, 0, 0), 'rgb'],
    ['RGB(255 0 0)', rgb(255, 0, 0), 'rgb'],
    ['rgb(100%, 0%, 0%)', rgb(255, 0, 0), 'rgb'],
    ['rgb(127.5 0 0)', rgb(128, 0, 0), 'rgb'],
    ['rgba(255, 0, 0, 1)', rgb(255, 0, 0), 'rgb'],
    ['rgb(255 0 0 / 100%)', rgb(255, 0, 0), 'rgb'],
    ['hsl(120, 100%, 50%)', rgb(0, 255, 0), 'hsl'],
    ['hsl(120deg 100% 50%)', rgb(0, 255, 0), 'hsl'],
    ['hsl(480 100 50)', rgb(0, 255, 0), 'hsl'],
    ['hsla(240, 100%, 50%, 1)', rgb(0, 0, 255), 'hsl'],
    ['oklch(62.8% 0.2577 29.23)', rgb(255, 0, 0), 'oklch'],
    ['oklch(0.628 0.2577 29.23deg)', rgb(255, 0, 0), 'oklch'],
    ['oklch(100% 0 0)', rgb(255, 255, 255), 'oklch'],
    ['oklch(0 0 0)', rgb(0, 0, 0), 'oklch'],
    ['cmyk(0%, 100%, 100%, 0%)', rgb(255, 0, 0), 'cmyk'],
    ['cmyk(0 100 100 0)', rgb(255, 0, 0), 'cmyk'],
    ['cmyk(0,0,0,100)', rgb(0, 0, 0), 'cmyk'],
  ] as const)('reads %s', (text, expected, format) => {
    expect(parseColor(text)).toEqual({ ok: true, rgb: expected, format, inGamut: true });
  });

  it('reads chroma as a percentage of 0.4', () => {
    const percent = parseColor('oklch(50% 50% 120)');
    const plain = parseColor('oklch(50% 0.2 120)');
    expect(percent).toEqual(plain);
  });

  it('flags an OKLCH colour that does not fit into sRGB', () => {
    expect(parseColor('oklch(70% 0.4 150)')).toMatchObject({ ok: true, inGamut: false });
  });
});

describe('parseColor: every error', () => {
  it.each<[string, ColorErrorCode]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['red', 'unknown'],
    ['hello world', 'unknown'],
    ['lab(50 40 30)', 'unknown'],
    ['#12', 'unknown'],
    ['#12345', 'unknown'],
    ['#gg0000', 'unknown'],
    ['rgb(1 2 3', 'unknown'],
    ['rgb(1 2)', 'syntax'],
    ['rgb(1 2 3 4 5)', 'syntax'],
    ['rgb(a b c)', 'syntax'],
    ['rgb(1 2 3deg)', 'syntax'],
    ['rgb(1 2 3 / x)', 'syntax'],
    ['rgb(1 2 3 / 2)', 'syntax'],
    ['rgb(1 2 3 / 10deg)', 'syntax'],
    ['rgb(256 0 0)', 'range'],
    ['rgb(-1 0 0)', 'range'],
    ['rgb(101% 0 0)', 'range'],
    ['hsl(1 2)', 'syntax'],
    ['hsl(50% 50% 50%)', 'syntax'],
    ['hsl(50 50deg 50%)', 'syntax'],
    ['hsl(50 50% 50deg)', 'syntax'],
    ['hsl(50 101% 50%)', 'range'],
    ['hsl(50 -1% 50%)', 'range'],
    ['hsl(50 50% 101%)', 'range'],
    ['oklch(1 2)', 'syntax'],
    ['oklch(50deg 0.1 20)', 'syntax'],
    ['oklch(50% 0.1deg 20)', 'syntax'],
    ['oklch(50% 0.1 20%)', 'syntax'],
    ['oklch(101% 0.1 20)', 'range'],
    ['oklch(-1 0.1 20)', 'range'],
    ['oklch(50% 1.1 20)', 'range'],
    ['oklch(50% -0.1 20)', 'range'],
    ['cmyk(1 2 3)', 'syntax'],
    ['cmyk(1 2 3 4deg)', 'syntax'],
    ['cmyk(1 2 3 4 / 1)', 'syntax'],
    ['cmyk(101 0 0 0)', 'range'],
    ['cmyk(0 -1 0 0)', 'range'],
    ['rgb(1e999 0 0)', 'syntax'],
    ['rgb(1 2 3 / 1 / 2)', 'syntax'],
    ['rgba(1, 2, 3, 1, 1)', 'syntax'],
  ])('rejects %j as %s', (text, error) => {
    expect(parseColor(text)).toEqual({ ok: false, error });
  });

  it.each([
    '#ff000080',
    '#f008',
    'rgba(255, 0, 0, 0.5)',
    'rgb(255 0 0 / 50%)',
    'hsl(0 100% 50% / 0)',
  ])('rejects the transparent colour %s', (text) => {
    expect(parseColor(text)).toEqual({ ok: false, error: 'alpha' });
  });

  it('never throws, whatever it is given', () => {
    const odd = [
      '(',
      ')',
      'rgb()',
      'rgb(,,)',
      'rgb(/)',
      '#',
      '%',
      'oklch(NaN 0 0)',
      'hsl(Infinity 1 1)',
      '\u0000',
      'rgb(1 2 3)) ',
    ];
    for (const text of odd) {
      expect(() => parseColor(text)).not.toThrow();
    }
  });
});

describe('rgbFromPicker', () => {
  it.each([
    ['#000000', rgb(0, 0, 0)],
    ['#ffffff', rgb(255, 255, 255)],
    ['#3a7bd5', rgb(58, 123, 213)],
    ['#0100ff', rgb(1, 0, 255)],
  ])('reads %s', (value, expected) => {
    expect(rgbFromPicker(value)).toEqual(expected);
  });
});

describe('contrast', () => {
  it('knows the extremes: 21:1 for black on white, 1:1 for equal colours', () => {
    expect(relativeLuminance(rgb(0, 0, 0))).toBe(0);
    expect(relativeLuminance(rgb(255, 255, 255))).toBeCloseTo(1, 12);
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 9);
    expect(contrastRatio(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 9);
    expect(contrastRatio(rgb(40, 50, 60), rgb(40, 50, 60))).toBe(1);
  });

  it('matches published values', () => {
    // #767676 on white is the well-known lightest grey that passes AA (4.54:1).
    expect(formatRatio(contrastRatio(rgb(0x76, 0x76, 0x76), rgb(255, 255, 255)))).toBe('4.54');
    // #777777 on white just fails (4.4777:1, shown cut to 4.47, never rounded up to 4.48).
    expect(formatRatio(contrastRatio(rgb(0x77, 0x77, 0x77), rgb(255, 255, 255)))).toBe('4.47');
  });

  it('cuts the ratio instead of rounding it up', () => {
    expect(formatRatio(4.499)).toBe('4.49');
    expect(formatRatio(4.5)).toBe('4.5');
    expect(formatRatio(21)).toBe('21');
    expect(formatRatio(1)).toBe('1');
    expect(formatRatio(2.3000000000000003)).toBe('2.3');
  });

  it('checks each level on both sides of its threshold', () => {
    const passes = (ratio: number): string[] =>
      checkContrast(ratio)
        .filter((check) => check.pass)
        .map((check) => check.id);
    expect(passes(1)).toEqual([]);
    expect(passes(2.99)).toEqual([]);
    expect(passes(3)).toEqual(['aa-large', 'ui']);
    expect(passes(4.49)).toEqual(['aa-large', 'ui']);
    expect(passes(4.5)).toEqual(['aa-normal', 'aa-large', 'aaa-large', 'ui']);
    expect(passes(6.99)).toEqual(['aa-normal', 'aa-large', 'aaa-large', 'ui']);
    expect(passes(7)).toEqual(['aa-normal', 'aa-large', 'aaa-normal', 'aaa-large', 'ui']);
    expect(checkContrast(21).map((check) => check.minimum)).toEqual([4.5, 3, 7, 4.5, 3]);
  });
});
