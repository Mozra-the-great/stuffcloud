/**
 * Colour maths of the colour tool: parsing and formatting of HEX, RGB, HSL, OKLCH and CMYK, and the
 * WCAG contrast ratio. Pure functions, no DOM, no dependency.
 *
 * The single source of truth is an opaque 8-bit sRGB colour (`Rgb`); every other format is derived
 * from it. A colour typed in another format is converted to it (OKLCH colours outside the sRGB
 * gamut get their chroma reduced until they fit).
 */

/** An opaque sRGB colour; every channel is an integer from 0 to 255. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Hue in degrees (0 to below 360), saturation and lightness in percent. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** Lightness 0 to 1, chroma 0 to about 0.4, hue in degrees (0 to below 360). */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** All four channels in percent. */
export interface Cmyk {
  readonly c: number;
  readonly m: number;
  readonly y: number;
  readonly k: number;
}

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'cmyk';

/** Why a text is not a colour; the tool shows a message per code. */
export type ColorErrorCode =
  /** Nothing was typed. */
  | 'empty'
  /** Not one of the five formats. */
  | 'unknown'
  /** A known format with the wrong number of values or an unreadable value. */
  | 'syntax'
  /** A value outside its range (for example `rgb(300, 0, 0)`). */
  | 'range'
  /** The colour is transparent; the tool works with opaque colours only. */
  | 'alpha';

export type ParsedColor =
  | {
      readonly ok: true;
      readonly rgb: Rgb;
      readonly format: ColorFormat;
      /** False when an OKLCH colour had to be brought into the sRGB gamut. */
      readonly inGamut: boolean;
    }
  | { readonly ok: false; readonly error: ColorErrorCode };

const fail = (error: ColorErrorCode): ParsedColor => ({ ok: false, error });

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Hue to the range 0 (included) to 360 (excluded). */
function wrapHue(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Rounds to `decimals` places (half away from zero is irrelevant here: values are not negative). */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A number as short text: at most `decimals` places, no trailing zeros, never `-0`. */
export function formatNumber(value: number, decimals: number): string {
  const rounded = round(value, decimals);
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

// ---------------------------------------------------------------------------------------------
// sRGB, HSL, CMYK

const channel = (value: number): number => Math.round(clamp(value, 0, 255));

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) {
    return { h: 0, s: 0, l: lightness * 100 };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = ((green - blue) / delta) % 6;
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }
  return { h: wrapHue(hue * 60), s: saturation * 100, l: lightness * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = wrapHue(h) / 60;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = lightness - chroma / 2;
  const sector = Math.floor(hue);
  const [red, green, blue] = (
    [
      [chroma, second, 0],
      [second, chroma, 0],
      [0, chroma, second],
      [0, second, chroma],
      [second, 0, chroma],
      [chroma, 0, second],
    ] as const
  )[sector % 6] ?? [0, 0, 0];
  return {
    r: channel((red + offset) * 255),
    g: channel((green + offset) * 255),
    b: channel((blue + offset) * 255),
  };
}

/** The plain device-independent formula (no ICC profile): K is the missing brightness. */
export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const k = 1 - Math.max(red, green, blue);
  if (k === 1) {
    return { c: 0, m: 0, y: 0, k: 100 };
  }
  return {
    c: ((1 - red - k) / (1 - k)) * 100,
    m: ((1 - green - k) / (1 - k)) * 100,
    y: ((1 - blue - k) / (1 - k)) * 100,
    k: k * 100,
  };
}

export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  const key = 1 - k / 100;
  return {
    r: channel(255 * (1 - c / 100) * key),
    g: channel(255 * (1 - m / 100) * key),
    b: channel(255 * (1 - y / 100) * key),
  };
}

// ---------------------------------------------------------------------------------------------
// OKLCH (Björn Ottosson's OKLab, as in CSS Color 4)

const toLinear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

const fromLinear = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const red = toLinear(r / 255);
  const green = toLinear(g / 255);
  const blue = toLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  // Below this chroma the colour is grey and its hue means nothing (rounding noise of the matrices).
  const hue = chroma < 1e-4 ? 0 : wrapHue((Math.atan2(bb, a) * 180) / Math.PI);
  return { l: clamp(lightness, 0, 1), c: chroma < 1e-4 ? 0 : chroma, h: hue };
}

/** Linear-light sRGB of an OKLCH colour; channels may fall outside 0 to 1 (out of gamut). */
function oklchToLinear({ l, c, h }: Oklch): readonly [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lPrime = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mPrime = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sPrime = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lPrime - 3.3077115913 * mPrime + 0.2309699292 * sPrime,
    -1.2684380046 * lPrime + 2.6097574011 * mPrime - 0.3413193965 * sPrime,
    -0.0041960863 * lPrime - 0.7034186147 * mPrime + 1.707614701 * sPrime,
  ];
}

/**
 * Slack for colours on the edge of the gamut: OKLCH is written with four decimals, so `oklch(62.8%
 * 0.2577 29.23)` (red) lands a hair outside. Half a thousandth in linear light is under two steps of
 * an 8-bit channel, and the channel is clamped anyway.
 */
const GAMUT_EPSILON = 5e-4;

function fitsGamut(linear: readonly [number, number, number]): boolean {
  return linear.every((value) => value >= -GAMUT_EPSILON && value <= 1 + GAMUT_EPSILON);
}

function linearToRgb(linear: readonly [number, number, number]): Rgb {
  const [r, g, b] = linear.map((value) => channel(fromLinear(clamp(value, 0, 1)) * 255));
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/**
 * OKLCH to sRGB. A colour outside the gamut keeps its lightness and hue and loses chroma, found by
 * bisection, until it fits; `inGamut` tells whether that was necessary.
 */
export function oklchToRgb(color: Oklch): { readonly rgb: Rgb; readonly inGamut: boolean } {
  const lightness = clamp(color.l, 0, 1);
  if (lightness === 0) {
    return { rgb: { r: 0, g: 0, b: 0 }, inGamut: color.c === 0 };
  }
  if (lightness === 1) {
    return { rgb: { r: 255, g: 255, b: 255 }, inGamut: color.c === 0 };
  }
  const exact = oklchToLinear({ ...color, l: lightness });
  if (fitsGamut(exact)) {
    return { rgb: linearToRgb(exact), inGamut: true };
  }
  let low = 0;
  let high = color.c;
  for (let step = 0; step < 32; step += 1) {
    const middle = (low + high) / 2;
    if (fitsGamut(oklchToLinear({ l: lightness, c: middle, h: color.h }))) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return {
    rgb: linearToRgb(oklchToLinear({ l: lightness, c: low, h: color.h })),
    inGamut: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting

const hexPair = (value: number): string => value.toString(16).padStart(2, '0');

export function formatHex({ r, g, b }: Rgb): string {
  return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
}

export function formatRgb({ r, g, b }: Rgb): string {
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

export function formatHsl(rgb: Rgb): string {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${formatNumber(h, 1)}, ${formatNumber(s, 1)}%, ${formatNumber(l, 1)}%)`;
}

export function formatOklch(rgb: Rgb): string {
  const { l, c, h } = rgbToOklch(rgb);
  return `oklch(${formatNumber(l * 100, 2)}% ${formatNumber(c, 4)} ${formatNumber(h, 2)})`;
}

export function formatCmyk(rgb: Rgb): string {
  const { c, m, y, k } = rgbToCmyk(rgb);
  return `cmyk(${formatNumber(c, 1)}%, ${formatNumber(m, 1)}%, ${formatNumber(y, 1)}%, ${formatNumber(k, 1)}%)`;
}

export interface FormattedColor {
  readonly format: ColorFormat;
  /** The name of the format as it is written, for example `HEX`. */
  readonly label: string;
  readonly value: string;
}

/** The colour in all five formats, in display order. */
export function formatAll(rgb: Rgb): readonly FormattedColor[] {
  return [
    { format: 'hex', label: 'HEX', value: formatHex(rgb) },
    { format: 'rgb', label: 'RGB', value: formatRgb(rgb) },
    { format: 'hsl', label: 'HSL', value: formatHsl(rgb) },
    { format: 'oklch', label: 'OKLCH', value: formatOklch(rgb) },
    { format: 'cmyk', label: 'CMYK', value: formatCmyk(rgb) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Parsing

const HEX = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = /^([a-z]+)\(\s*([^()]*?)\s*\)$/i;
const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i;

interface Value {
  readonly number: number;
  readonly unit: '' | '%' | 'deg';
}

function readValue(token: string): Value | undefined {
  const match = NUMBER.exec(token);
  if (match === null) {
    return undefined;
  }
  const number = Number(match[1]);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return { number, unit: (match[2]?.toLowerCase() ?? '') as Value['unit'] };
}

function parseHex(digits: string): ParsedColor {
  const full = digits.length <= 4 ? Array.from(digits, (digit) => digit + digit).join('') : digits;
  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) : 255;
  if (alpha !== 255) {
    return fail('alpha');
  }
  return { ok: true, rgb: { r: red, g: green, b: blue }, format: 'hex', inGamut: true };
}

/** `name(a b c)`, `name(a, b, c)` and `name(a b c / alpha)`: the values and the alpha token, if any. */
function splitArguments(body: string): { values: string[]; alpha: string | undefined } {
  const slash = body.indexOf('/');
  const main = slash === -1 ? body : body.slice(0, slash);
  return {
    values: main.split(/[\s,]+/).filter((token) => token !== ''),
    alpha: slash === -1 ? undefined : body.slice(slash + 1).trim(),
  };
}

/** The alpha value is fine when it is 1 or 100 %; anything less is transparent. */
function alphaOpaque(token: string): boolean | undefined {
  const value = readValue(token);
  if (value === undefined || value.unit === 'deg') {
    return undefined;
  }
  const alpha = value.unit === '%' ? value.number / 100 : value.number;
  if (alpha < 0 || alpha > 1) {
    return undefined;
  }
  return alpha === 1;
}

type Triple = readonly [Value, Value, Value];
type Quad = readonly [Value, Value, Value, Value];

const exact = (rgb: Rgb, format: ColorFormat, inGamut = true): ParsedColor => ({
  ok: true,
  rgb,
  format,
  inGamut,
});

/** A channel: a number of the given maximum or a percentage of it. */
function scaled(value: Value, max: number): number | undefined {
  if (value.unit === 'deg') {
    return undefined;
  }
  const result = value.unit === '%' ? (value.number / 100) * max : value.number;
  return result >= 0 && result <= max ? result : undefined;
}

const parseRgb = (values: Triple): ParsedColor => {
  if (values.some((value) => value.unit === 'deg')) {
    return fail('syntax');
  }
  const [r, g, b] = values.map((value) => scaled(value, 255));
  if (r === undefined || g === undefined || b === undefined) {
    return fail('range');
  }
  return exact({ r: channel(r), g: channel(g), b: channel(b) }, 'rgb');
};

const parseHsl = ([hue, saturation, lightness]: Triple): ParsedColor => {
  if (hue.unit === '%' || saturation.unit === 'deg' || lightness.unit === 'deg') {
    return fail('syntax');
  }
  const s = saturation.number;
  const l = lightness.number;
  if (s < 0 || s > 100 || l < 0 || l > 100) {
    return fail('range');
  }
  return exact(hslToRgb({ h: hue.number, s, l }), 'hsl');
};

const parseOklch = ([lightness, chroma, hue]: Triple): ParsedColor => {
  if (lightness.unit === 'deg' || chroma.unit === 'deg' || hue.unit === '%') {
    return fail('syntax');
  }
  const l = lightness.unit === '%' ? lightness.number / 100 : lightness.number;
  // CSS Color 4: 100 % chroma is 0.4.
  const c = chroma.unit === '%' ? (chroma.number / 100) * 0.4 : chroma.number;
  if (l < 0 || l > 1 || c < 0 || c > 1) {
    return fail('range');
  }
  const { rgb, inGamut } = oklchToRgb({ l, c, h: wrapHue(hue.number) });
  return exact(rgb, 'oklch', inGamut);
};

const parseCmyk = (parts: Quad): ParsedColor => {
  if (parts.some((part) => part.unit === 'deg')) {
    return fail('syntax');
  }
  // Percent signs are optional: cmyk(0 100 100 0) is red.
  if (parts.some((part) => part.number < 0 || part.number > 100)) {
    return fail('range');
  }
  const [c, m, y, k] = parts;
  return exact(cmykToRgb({ c: c.number, m: m.number, y: y.number, k: k.number }), 'cmyk');
};

interface Definition {
  /** `rgb(1 2 3 / 0.5)` and `rgba(1, 2, 3, 0.5)` take an alpha value; `cmyk` does not. */
  readonly alpha: boolean;
  /** Reads the values; there are exactly as many as `count`. */
  readonly parse: (values: readonly Value[]) => ParsedColor;
  readonly count: number;
}

const FUNCTIONS: Readonly<Record<string, Definition>> = {
  rgb: { alpha: true, count: 3, parse: (values) => parseRgb(values as unknown as Triple) },
  rgba: { alpha: true, count: 3, parse: (values) => parseRgb(values as unknown as Triple) },
  hsl: { alpha: true, count: 3, parse: (values) => parseHsl(values as unknown as Triple) },
  hsla: { alpha: true, count: 3, parse: (values) => parseHsl(values as unknown as Triple) },
  oklch: { alpha: true, count: 3, parse: (values) => parseOklch(values as unknown as Triple) },
  cmyk: { alpha: false, count: 4, parse: (values) => parseCmyk(values as unknown as Quad) },
};

/** Reads a colour in any of the five formats; never throws. */
export function parseColor(text: string): ParsedColor {
  const input = text.trim();
  if (input === '') {
    return fail('empty');
  }
  const hex = HEX.exec(input);
  if (hex !== null) {
    return parseHex(String(hex[1]));
  }
  const call = FUNCTION.exec(input);
  const definition = call === null ? undefined : FUNCTIONS[String(call[1]).toLowerCase()];
  if (call === null || definition === undefined) {
    return fail('unknown');
  }
  const { values, alpha } = splitArguments(String(call[2]));
  // The legacy comma syntax puts the alpha value fourth: rgba(1, 2, 3, 0.5).
  let alphaToken = alpha;
  if (definition.alpha && values.length === definition.count + 1 && alpha === undefined) {
    alphaToken = values.pop();
  }
  if (values.length !== definition.count) {
    return fail('syntax');
  }
  const numbers = values.map(readValue);
  if (numbers.some((value) => value === undefined)) {
    return fail('syntax');
  }
  if (alphaToken !== undefined) {
    if (!definition.alpha) {
      return fail('syntax');
    }
    const opaque = alphaOpaque(alphaToken);
    if (opaque === undefined) {
      return fail('syntax');
    }
    if (!opaque) {
      return fail('alpha');
    }
  }
  return definition.parse(numbers as Value[]);
}

/** The value of `<input type="color">`: always `#rrggbb`. */
export function rgbFromPicker(value: string): Rgb {
  const packed = Number.parseInt(value.slice(1), 16);
  return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
}

// ---------------------------------------------------------------------------------------------
// Contrast (WCAG 2.2, success criteria 1.4.3, 1.4.6 and 1.4.11)

/** Relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
}

/** The contrast ratio, 1 to 21; the order of the two colours does not matter. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The ratio for display: cut (not rounded) to two places, because 4.499 must not read as 4.5. */
export function formatRatio(ratio: number): string {
  return String(Math.floor(ratio * 100 + 1e-9) / 100);
}

export type ContrastCheckId = 'aa-normal' | 'aa-large' | 'aaa-normal' | 'aaa-large' | 'ui';

export interface ContrastCheck {
  readonly id: ContrastCheckId;
  /** The ratio the check asks for. */
  readonly minimum: number;
}

/** The thresholds of WCAG 2.2: AA 4.5 and 3 (large text), AAA 7 and 4.5, UI parts and graphics 3. */
export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  { id: 'aa-normal', minimum: 4.5 },
  { id: 'aa-large', minimum: 3 },
  { id: 'aaa-normal', minimum: 7 },
  { id: 'aaa-large', minimum: 4.5 },
  { id: 'ui', minimum: 3 },
];

export interface ContrastResult {
  readonly id: ContrastCheckId;
  readonly minimum: number;
  readonly pass: boolean;
}

/** Each check against the unrounded ratio. */
export function checkContrast(ratio: number): readonly ContrastResult[] {
  return CONTRAST_CHECKS.map((check) => ({ ...check, pass: ratio >= check.minimum }));
}
