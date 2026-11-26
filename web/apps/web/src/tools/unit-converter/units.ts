import type { Locale, Message, MessageKey } from '../../i18n/index.ts';
import { de } from '../../i18n/messages/de.ts';
import { en } from '../../i18n/messages/en.ts';

/**
 * The unit tables of the unit converter. Every unit knows how to get to the base unit of its
 * category and back; linear units do that with one factor, temperatures with an offset. The
 * factors are exact definitions (the international inch is 0.0254 m, the avoirdupois pound is
 * 0.45359237 kg, a US gallon is 231 cubic inches), not measurements.
 */

export type CategoryId =
  'length' | 'mass' | 'temperature' | 'data' | 'time' | 'speed' | 'area' | 'volume';

export interface Unit {
  /** Unique within its category; it is the value of the `<option>`. */
  readonly id: string;
  /** Written the same in every language (`km`, `GiB`, `°C`). */
  readonly symbol: string;
  readonly nameKey: MessageKey;
  /** The value in the base unit of the category. */
  readonly toBase: (value: number) => number;
  /** The value in this unit, from the base unit. */
  readonly fromBase: (value: number) => number;
}

/** A category always has units. */
export type Units = readonly [Unit, ...Unit[]];

export interface Category {
  readonly id: CategoryId;
  readonly nameKey: MessageKey;
  readonly units: Units;
  /** The units shown when the category is chosen: from and to. */
  readonly defaults: readonly [from: string, to: string];
  /** Smallest value in the base unit, when there is one: absolute zero, -273.15 °C. */
  readonly minimumBase?: number;
}

function linear(id: string, symbol: string, nameKey: MessageKey, factor: number): Unit {
  return {
    id,
    symbol,
    nameKey,
    toBase: (value) => value * factor,
    fromBase: (value) => value / factor,
  };
}

function offset(
  id: string,
  symbol: string,
  nameKey: MessageKey,
  toBase: (value: number) => number,
  fromBase: (value: number) => number,
): Unit {
  return { id, symbol, nameKey, toBase, fromBase };
}

const LENGTH: Units = [
  linear('nm', 'nm', 'unit.length.nm', 1e-9),
  linear('um', 'µm', 'unit.length.um', 1e-6),
  linear('mm', 'mm', 'unit.length.mm', 1e-3),
  linear('cm', 'cm', 'unit.length.cm', 1e-2),
  linear('m', 'm', 'unit.length.m', 1),
  linear('km', 'km', 'unit.length.km', 1e3),
  linear('in', 'in', 'unit.length.in', 0.0254),
  linear('ft', 'ft', 'unit.length.ft', 0.3048),
  linear('yd', 'yd', 'unit.length.yd', 0.9144),
  linear('mi', 'mi', 'unit.length.mi', 1609.344),
  linear('nmi', 'nmi', 'unit.length.nmi', 1852),
];

const MASS: Units = [
  linear('ug', 'µg', 'unit.mass.ug', 1e-9),
  linear('mg', 'mg', 'unit.mass.mg', 1e-6),
  linear('g', 'g', 'unit.mass.g', 1e-3),
  linear('kg', 'kg', 'unit.mass.kg', 1),
  linear('t', 't', 'unit.mass.t', 1000),
  linear('oz', 'oz', 'unit.mass.oz', 0.028349523125),
  linear('lb', 'lb', 'unit.mass.lb', 0.45359237),
  linear('st', 'st', 'unit.mass.st', 6.35029318),
  linear('ton', 'tn', 'unit.mass.ton', 907.18474),
];

// The base is the degree Celsius: the everyday conversions (Celsius and Fahrenheit) then take one
// multiplication and one addition, with no detour through a number near 273 that would cost digits.
const TEMPERATURE: Units = [
  offset(
    'c',
    '°C',
    'unit.temperature.c',
    (value) => value,
    (value) => value,
  ),
  offset(
    'f',
    '°F',
    'unit.temperature.f',
    (value) => ((value - 32) * 5) / 9,
    (value) => (value * 9) / 5 + 32,
  ),
  offset(
    'k',
    'K',
    'unit.temperature.k',
    (value) => value - 273.15,
    (value) => value + 273.15,
  ),
  offset(
    'r',
    '°R',
    'unit.temperature.r',
    (value) => ((value - 491.67) * 5) / 9,
    (value) => (value * 9) / 5 + 491.67,
  ),
];

// The base is the byte. "kB" is 1000 bytes (SI), "KiB" is 1024 bytes (IEC): both are listed, and
// they are never mixed up.
const DATA: Units = [
  linear('bit', 'bit', 'unit.data.bit', 1 / 8),
  linear('byte', 'B', 'unit.data.byte', 1),
  linear('kb', 'kB', 'unit.data.kb', 1e3),
  linear('mb', 'MB', 'unit.data.mb', 1e6),
  linear('gb', 'GB', 'unit.data.gb', 1e9),
  linear('tb', 'TB', 'unit.data.tb', 1e12),
  linear('pb', 'PB', 'unit.data.pb', 1e15),
  linear('kib', 'KiB', 'unit.data.kib', 2 ** 10),
  linear('mib', 'MiB', 'unit.data.mib', 2 ** 20),
  linear('gib', 'GiB', 'unit.data.gib', 2 ** 30),
  linear('tib', 'TiB', 'unit.data.tib', 2 ** 40),
  linear('pib', 'PiB', 'unit.data.pib', 2 ** 50),
  linear('kbit', 'kbit', 'unit.data.kbit', 1e3 / 8),
  linear('mbit', 'Mbit', 'unit.data.mbit', 1e6 / 8),
  linear('gbit', 'Gbit', 'unit.data.gbit', 1e9 / 8),
  linear('tbit', 'Tbit', 'unit.data.tbit', 1e12 / 8),
];

// A year is 365.25 days (the Julian year); calendar months are left out: they differ in length.
const TIME: Units = [
  linear('ns', 'ns', 'unit.time.ns', 1e-9),
  linear('us', 'µs', 'unit.time.us', 1e-6),
  linear('ms', 'ms', 'unit.time.ms', 1e-3),
  linear('s', 's', 'unit.time.s', 1),
  linear('min', 'min', 'unit.time.min', 60),
  linear('h', 'h', 'unit.time.h', 3600),
  linear('d', 'd', 'unit.time.d', 86_400),
  linear('wk', 'wk', 'unit.time.wk', 604_800),
  linear('yr', 'yr', 'unit.time.yr', 31_557_600),
];

const SPEED: Units = [
  linear('ms', 'm/s', 'unit.speed.ms', 1),
  linear('kmh', 'km/h', 'unit.speed.kmh', 1000 / 3600),
  linear('mph', 'mph', 'unit.speed.mph', 0.44704),
  linear('kn', 'kn', 'unit.speed.kn', 1852 / 3600),
  linear('fts', 'ft/s', 'unit.speed.fts', 0.3048),
];

const AREA: Units = [
  linear('mm2', 'mm²', 'unit.area.mm2', 1e-6),
  linear('cm2', 'cm²', 'unit.area.cm2', 1e-4),
  linear('m2', 'm²', 'unit.area.m2', 1),
  linear('ha', 'ha', 'unit.area.ha', 1e4),
  linear('km2', 'km²', 'unit.area.km2', 1e6),
  linear('in2', 'in²', 'unit.area.in2', 0.00064516),
  linear('ft2', 'ft²', 'unit.area.ft2', 0.09290304),
  linear('yd2', 'yd²', 'unit.area.yd2', 0.83612736),
  linear('ac', 'ac', 'unit.area.ac', 4046.8564224),
  linear('mi2', 'mi²', 'unit.area.mi2', 2_589_988.110336),
];

// The base is the litre. US and imperial measures share names, so the names say which is which.
const VOLUME: Units = [
  linear('ml', 'mL', 'unit.volume.ml', 1e-3),
  linear('cm3', 'cm³', 'unit.volume.cm3', 1e-3),
  linear('l', 'L', 'unit.volume.l', 1),
  linear('m3', 'm³', 'unit.volume.m3', 1000),
  linear('tsp', 'tsp', 'unit.volume.tsp', 0.00492892159375),
  linear('tbsp', 'tbsp', 'unit.volume.tbsp', 0.01478676478125),
  linear('floz', 'fl oz', 'unit.volume.floz', 0.0295735295625),
  linear('cup', 'cup', 'unit.volume.cup', 0.2365882365),
  linear('pt', 'pt', 'unit.volume.pt', 0.473176473),
  linear('qt', 'qt', 'unit.volume.qt', 0.946352946),
  linear('gal', 'gal', 'unit.volume.gal', 3.785411784),
  linear('ptimp', 'pt (imp)', 'unit.volume.ptimp', 0.56826125),
  linear('galimp', 'gal (imp)', 'unit.volume.galimp', 4.54609),
];

const ABSOLUTE_ZERO_CELSIUS = -273.15;

/** Rounding noise of the conversion (about 1e-13) must not turn exact absolute zero into an error. */
const MINIMUM_SLACK = 1e-9;

export const CATEGORIES: readonly [Category, ...Category[]] = [
  { id: 'length', nameKey: 'unit.category.length', units: LENGTH, defaults: ['km', 'mi'] },
  { id: 'mass', nameKey: 'unit.category.mass', units: MASS, defaults: ['kg', 'lb'] },
  {
    id: 'temperature',
    nameKey: 'unit.category.temperature',
    units: TEMPERATURE,
    defaults: ['c', 'f'],
    minimumBase: ABSOLUTE_ZERO_CELSIUS,
  },
  { id: 'data', nameKey: 'unit.category.data', units: DATA, defaults: ['gb', 'gib'] },
  { id: 'time', nameKey: 'unit.category.time', units: TIME, defaults: ['h', 'min'] },
  { id: 'speed', nameKey: 'unit.category.speed', units: SPEED, defaults: ['kmh', 'mph'] },
  { id: 'area', nameKey: 'unit.category.area', units: AREA, defaults: ['m2', 'ft2'] },
  { id: 'volume', nameKey: 'unit.category.volume', units: VOLUME, defaults: ['l', 'gal'] },
];

export function findCategory(id: string): Category | undefined {
  return CATEGORIES.find((category) => category.id === id);
}

export function findUnit(category: Category, id: string): Unit | undefined {
  return category.units.find((unit) => unit.id === id);
}

/** The category with this id, or the first one when there is none (a stale or hand-edited value). */
export function categoryOrFirst(id: string): Category {
  return findCategory(id) ?? CATEGORIES[0];
}

/** The unit with this id, or the first of the category. */
export function unitOrFirst(category: Category, id: string): Unit {
  return findUnit(category, id) ?? category.units[0];
}

// ---------------------------------------------------------------------------------------------
// Numbers in and out

export type NumberErrorCode = 'empty' | 'syntax' | 'range';

export type ParsedNumber =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: NumberErrorCode };

const DECIMAL = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads what a person types: `1234.5`, `1234,5` (one decimal separator, either one), `1 234.5`
 * and `1_234.5` (spaces and underscores group digits), `-3`, `1e6`. A text with both a dot and a
 * comma is refused: it cannot be told which one is the decimal separator.
 */
export function parseNumber(text: string): ParsedNumber {
  const cleaned = text.replaceAll('\u2212', '-').replace(/[\s_\u00a0\u202f]/g, '');
  if (cleaned === '') {
    return { ok: false, error: 'empty' };
  }
  // A text with a dot and a comma does not match `DECIMAL`, which allows one separator.
  if (!DECIMAL.test(cleaned)) {
    return { ok: false, error: 'syntax' };
  }
  const value = Number(cleaned.replace(',', '.'));
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'range' };
}

export const MIN_PRECISION = 1;
export const MAX_PRECISION = 15;
export const DEFAULT_PRECISION = 6;

/** Significant digits from text: out of range or unreadable falls back to the nearest valid value. */
export function parsePrecision(text: string): number {
  // `Number` ignores white space around the digits, but reads a text of white space only as 0.
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) {
    return DEFAULT_PRECISION;
  }
  return Math.min(MAX_PRECISION, Math.max(MIN_PRECISION, Math.round(value)));
}

/**
 * A number with at most `precision` significant digits, no trailing zeros. Plain decimal notation
 * from 0.000001 up to 999999999999999; outside that range scientific notation (`1.5e+21`), because
 * a string of twenty zeros cannot be read.
 */
export function formatValue(value: number, precision: number): string {
  const digits = Math.min(MAX_PRECISION, Math.max(MIN_PRECISION, Math.round(precision)));
  const rounded = Number(value.toPrecision(digits));
  const size = Math.abs(rounded);
  // `String` writes 0 and -0 as '0', and a value below 1e-6 `String` writes the exponent form itself, in the same shape as here.
  if (size >= 1e15) {
    const exponential = rounded.toExponential(digits - 1);
    const cut = exponential.indexOf('e');
    // The mantissa is one digit, a dot and more digits, or one digit: only zeros after the dot go.
    const trimmed = exponential.slice(0, cut).replace(/\.?0+$/, '');
    return `${trimmed}e${exponential.slice(cut + 1)}`;
  }
  return String(rounded);
}

/** The decimal separator of the language: German writes a comma. */
export function localizeNumber(text: string, locale: Locale): string {
  return locale === 'de' ? text.replace('.', ',') : text;
}

// ---------------------------------------------------------------------------------------------
// Converting

export type ConvertErrorCode = 'below-absolute-zero' | 'overflow';

export type Conversion =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: ConvertErrorCode };

/** `value` of `from` expressed in `to`. A value below the category's minimum (absolute zero) is an error. */
export function convert(category: Category, from: Unit, to: Unit, value: number): Conversion {
  const base = from.toBase(value);
  if (!Number.isFinite(base)) {
    return { ok: false, error: 'overflow' };
  }
  const floor = category.minimumBase ?? Number.NEGATIVE_INFINITY;
  if (base < floor - MINIMUM_SLACK) {
    return { ok: false, error: 'below-absolute-zero' };
  }
  const result = from === to ? value : to.fromBase(base);
  return Number.isFinite(result) ? { ok: true, value: result } : { ok: false, error: 'overflow' };
}

export interface ConvertedUnit {
  readonly unit: Unit;
  readonly result: Conversion;
}

/** `value` of `from` in every unit of the category, in table order. */
export function convertAll(
  category: Category,
  from: Unit,
  value: number,
): readonly ConvertedUnit[] {
  return category.units.map((unit) => ({ unit, result: convert(category, from, unit, value) }));
}

// ---------------------------------------------------------------------------------------------
// Search

export interface UnitHit {
  readonly category: Category;
  readonly unit: Unit;
}

const CATALOGUES = { en, de } as const;

/** A message as plain text; a plural message reads as its general form. */
function plain(message: Message): string {
  return typeof message === 'string' ? message : message.other;
}

/** The name of a unit in a language, from the catalogue. */
export function unitName(unit: Unit, locale: Locale): string {
  return plain(CATALOGUES[locale][unit.nameKey]);
}

export function categoryName(category: Category, locale: Locale): string {
  return plain(CATALOGUES[locale][category.nameKey]);
}

/** Lower case, without accents, and the American spellings next to the British ones. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(?<=\p{L})tre\b/gu, 'ter')
    .replace(/ß/gu, 'ss');
}

export const MAX_HITS = 12;

/**
 * Units whose id, symbol, name (in any language) or category name contains every word of `query`.
 * Exact matches come first, then names that start with the query, then the rest, each group in
 * table order. No query, no hits.
 */
export function searchUnits(query: string): readonly UnitHit[] {
  const words = normalize(query)
    .split(/\s/)
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  const joined = words.join(' ');
  const ranked: { hit: UnitHit; rank: number }[] = [];
  for (const category of CATEGORIES) {
    for (const unit of category.units) {
      const names = [normalize(unitName(unit, 'en')), normalize(unitName(unit, 'de'))];
      const own = [normalize(unit.id), normalize(unit.symbol), ...names];
      const haystack = [
        ...own,
        normalize(categoryName(category, 'en')),
        normalize(categoryName(category, 'de')),
      ].join(' ');
      if (!words.every((word) => haystack.includes(word))) {
        continue;
      }
      let rank = 2;
      if (own.includes(joined)) {
        rank = 0;
      } else if (own.some((text) => text.startsWith(joined))) {
        rank = 1;
      }
      ranked.push({ hit: { category, unit }, rank });
    }
  }
  return (
    ranked
      // `sort` is stable, so hits of one rank stay in table order.
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_HITS)
      .map((entry) => entry.hit)
  );
}
