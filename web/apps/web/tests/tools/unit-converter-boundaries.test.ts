import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  DEFAULT_PRECISION,
  MAX_HITS,
  categoryName,
  convert,
  findCategory,
  findUnit,
  formatValue,
  parseNumber,
  parsePrecision,
  searchUnits,
  unitName,
  type Category,
  type Unit,
} from '../../src/tools/unit-converter/units.ts';

function categoryOf(id: string): Category {
  const category = findCategory(id);
  if (category === undefined) {
    throw new Error(id);
  }
  return category;
}

function unitOf(category: Category, id: string): Unit {
  const unit = findUnit(category, id);
  if (unit === undefined) {
    throw new Error(id);
  }
  return unit;
}

describe('parseNumber', () => {
  it('reads a decimal that starts with the separator, with any number of digits', () => {
    expect(parseNumber('.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseNumber('.55')).toEqual({ ok: true, value: 0.55 });
    expect(parseNumber(',25')).toEqual({ ok: true, value: 0.25 });
    expect(parseNumber('-.125')).toEqual({ ok: true, value: -0.125 });
    expect(parseNumber('.5e2')).toEqual({ ok: true, value: 50 });
  });

  it.each([
    '1.234,5',
    '1,234.5',
    '1,2,3',
    '1.2.3',
    '.',
    ',',
    '1e',
    'e5',
    '--1',
    '1-',
    'abc',
    '0x10',
  ])('refuses %s as a syntax error', (text) => {
    expect(parseNumber(text)).toEqual({ ok: false, error: 'syntax' });
  });
});

describe('parsePrecision', () => {
  it('falls back to the default for nothing, white space and non-numbers', () => {
    for (const text of ['', ' ', '   ', '\t\n', 'x', 'NaN', 'Infinity', '-Infinity', '1e999']) {
      expect(parsePrecision(text), JSON.stringify(text)).toBe(DEFAULT_PRECISION);
    }
  });

  it('reads a number with white space around it, rounds it and keeps it in range', () => {
    expect(parsePrecision(' 7 ')).toBe(7);
    expect(parsePrecision('7.4')).toBe(7);
    expect(parsePrecision('7.5')).toBe(8);
    expect(parsePrecision('0')).toBe(1);
    expect(parsePrecision('-3')).toBe(1);
    expect(parsePrecision('15')).toBe(15);
    expect(parsePrecision('16')).toBe(15);
    expect(parsePrecision('99')).toBe(15);
  });
});

describe('formatValue', () => {
  it('writes plain digits up to 999999999999999 and scientific notation from 1e15', () => {
    expect(formatValue(999_999_999_999_999, 15)).toBe('999999999999999');
    expect(formatValue(1e15, 6)).toBe('1e+15');
    expect(formatValue(-1e15, 6)).toBe('-1e+15');
    expect(formatValue(2.5e18, 6)).toBe('2.5e+18');
    expect(formatValue(1.234_567_890_123_456_8e17, 15)).toBe('1.23456789012346e+17');
    expect(formatValue(1.05e20, 6)).toBe('1.05e+20');
    expect(formatValue(-1.5e20, 6)).toBe('-1.5e+20');
    expect(formatValue(1e21, 6)).toBe('1e+21');
    expect(formatValue(1.0e100, 3)).toBe('1e+100');
  });

  it('writes plain digits down to 0.000001 and scientific notation below it', () => {
    expect(formatValue(0.000_001, 6)).toBe('0.000001');
    expect(formatValue(0.000_001_5, 6)).toBe('0.0000015');
    expect(formatValue(9.9999e-7, 6)).toBe('9.9999e-7');
    expect(formatValue(1e-7, 6)).toBe('1e-7');
    expect(formatValue(1.5e-7, 6)).toBe('1.5e-7');
    expect(formatValue(-1.05e-9, 6)).toBe('-1.05e-9');
    expect(formatValue(1.2345e-300, 3)).toBe('1.23e-300');
  });

  it('keeps the zeros inside the mantissa and drops only those at its end', () => {
    expect(formatValue(1.05e20, 3)).toBe('1.05e+20');
    expect(formatValue(1.005e20, 4)).toBe('1.005e+20');
    expect(formatValue(1.1e20, 6)).toBe('1.1e+20');
    expect(formatValue(1.0e20, 6)).toBe('1e+20');
    expect(formatValue(5e20, 1)).toBe('5e+20');
    expect(formatValue(1.04e20, 2)).toBe('1e+20');
  });

  it('never writes more digits than the precision, whatever the number', () => {
    let state = 12_345;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 2 ** 32;
    };
    for (let round = 0; round < 3000; round += 1) {
      const precision = 1 + Math.floor(next() * 15);
      const exponent = Math.floor(next() * 600 - 300);
      const value = (next() * 9 + 1) * 10 ** exponent * (next() < 0.5 ? -1 : 1);
      const text = formatValue(value, precision);
      // Trailing zeros of a whole number are place holders, not digits.
      const digits = text
        .replace(/e.*$/, '')
        .replace(/[-.]/g, '')
        .replace(/^0+/, '')
        .replace(/0+$/, '');
      expect(digits.length, `${String(value)} at ${String(precision)}`).toBeLessThanOrEqual(
        precision,
      );
      expect(Number(text), `${String(value)} at ${String(precision)}`).toBe(
        Number(value.toPrecision(precision)),
      );
    }
  });
});

describe('convert', () => {
  const temperature = categoryOf('temperature');
  const celsius = unitOf(temperature, 'c');
  const kelvin = unitOf(temperature, 'k');

  it('allows a hair below absolute zero for rounding and refuses more', () => {
    expect(convert(temperature, celsius, kelvin, -273.15)).toMatchObject({ ok: true });
    expect(convert(temperature, celsius, kelvin, -273.15 - 1e-9)).toMatchObject({ ok: true });
    expect(convert(temperature, celsius, kelvin, -273.15 - 2e-9)).toEqual({
      ok: false,
      error: 'below-absolute-zero',
    });
    expect(convert(temperature, celsius, kelvin, -300)).toEqual({
      ok: false,
      error: 'below-absolute-zero',
    });
  });

  it('has no lower limit in the categories without a minimum', () => {
    const length = categoryOf('length');
    expect(convert(length, unitOf(length, 'm'), unitOf(length, 'km'), -5e12)).toMatchObject({
      ok: true,
      value: -5e9,
    });
    expect(convert(length, unitOf(length, 'm'), unitOf(length, 'km'), -1e300)).toMatchObject({
      ok: true,
    });
  });

  it('is overflow when the value in the base unit does not fit, even into the same unit', () => {
    const length = categoryOf('length');
    const kilometre = unitOf(length, 'km');
    expect(convert(length, kilometre, kilometre, 1e306)).toEqual({ ok: false, error: 'overflow' });
    expect(convert(length, kilometre, unitOf(length, 'm'), 1e306)).toEqual({
      ok: false,
      error: 'overflow',
    });
    expect(convert(length, unitOf(length, 'm'), unitOf(length, 'nm'), 1e300)).toEqual({
      ok: false,
      error: 'overflow',
    });
  });

  it('gives the number back unchanged when the unit does not change', () => {
    for (const category of CATEGORIES) {
      for (const unit of category.units) {
        for (const value of [0.1, 1 / 3, 123.456, 98_765.4321, 7]) {
          if (category.minimumBase !== undefined && unit.toBase(value) < category.minimumBase) {
            continue;
          }
          expect(
            convert(category, unit, unit, value),
            `${category.id}/${unit.id} ${String(value)}`,
          ).toEqual({
            ok: true,
            value,
          });
        }
      }
    }
  });
});

/** Lower case, no accents, the American spelling, `ß` as `ss`: the same rule as the search, written again. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(?<=\p{L})tre\b/gu, 'ter')
    .replace(/ß/gu, 'ss');
}

function fieldsOf(category: Category, unit: Unit): { own: string[]; all: string[] } {
  const own = [unit.id, unit.symbol, unitName(unit, 'en'), unitName(unit, 'de')].map(fold);
  return {
    own,
    all: [...own, fold(categoryName(category, 'en')), fold(categoryName(category, 'de'))],
  };
}

/** What `searchUnits` has to return, worked out from the tables with a plain loop. */
function expected(query: string): string[] {
  const words = fold(query)
    .split(' ')
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  const joined = words.join(' ');
  const hits: { id: string; rank: number; order: number }[] = [];
  let order = 0;
  for (const category of CATEGORIES) {
    for (const unit of category.units) {
      order += 1;
      const { own, all } = fieldsOf(category, unit);
      if (!words.every((word) => all.join(' ').includes(word))) {
        continue;
      }
      const rank = own.includes(joined) ? 0 : own.some((text) => text.startsWith(joined)) ? 1 : 2;
      hits.push({ id: `${category.id}/${unit.id}`, rank, order });
    }
  }
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return hits.slice(0, MAX_HITS).map((hit) => hit.id);
}

function found(query: string): string[] {
  return searchUnits(query).map((hit) => `${hit.category.id}/${hit.unit.id}`);
}

describe('searchUnits', () => {
  it('finds the metre by the British and the American spelling, with and without accents and capitals', () => {
    for (const query of ['metre', 'meter', 'METRE', 'Meter', 'mètre', 'METER']) {
      expect(found(query)[0], query).toBe('length/m');
    }
  });

  it('turns -tre into -ter only after a letter, in the unit names too', () => {
    expect(found('square centimeter')[0]).toBe('area/cm2');
    expect(found('square centimetre')[0]).toBe('area/cm2');
    expect(found('Square Centimeter')[0]).toBe('area/cm2');
    expect(found('kilometer per hour')[0]).toBe('speed/kmh');
    expect(found('litre')[0]).toBe('volume/l');
    // A query of several words ranks the unit whose whole name it is above units that only contain the words.
    expect(found('square meter')[0]).toBe('area/m2');
    expect(found('square meter')).toContain('area/cm2');
    expect(found('square meter').indexOf('area/cm2')).toBeGreaterThan(0);
  });

  it('finds a German name by its text without accents and with ss for ß', () => {
    expect(found('lange')).toContain('length/m');
    expect(found('Länge')).toContain('length/m');
    expect(found('fuss')).toContain('length/ft');
    expect(found('Fuß')).toContain('length/ft');
    expect(found('flache')).toContain('area/m2');
  });

  it('puts exact matches first, then names that start with the text, then the rest, each in table order', () => {
    for (const query of [
      'm',
      'kilo',
      'meter',
      'gram',
      'square',
      'l',
      'gal',
      'ft',
      'c',
      'h',
      'per',
      'in',
      'byte',
      'pound',
      'k',
    ]) {
      expect(found(query), query).toEqual(expected(query));
    }
  });

  it('matches several words in any order, each inside the text of one unit', () => {
    expect(found('hour kilometer')).toEqual(expected('hour kilometer'));
    expect(found('per second')).toEqual(expected('per second'));
    expect(found('  kilometer   per   hour  ')[0]).toBe('speed/kmh');
    expect(found('kilometer per hour')).toEqual(expected('kilometer per hour'));
    expect(found('kilometer per hour')[0]).toBe('speed/kmh');
  });

  it('gives no hits for no words and at most MAX_HITS for many', () => {
    expect(searchUnits('')).toEqual([]);
    expect(searchUnits('   ')).toEqual([]);
    expect(searchUnits('e').length).toBe(MAX_HITS);
    expect(found('e')).toEqual(expected('e'));
  });

  it('never matches across the end of one text and the start of the next', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const first of letters) {
      for (const second of letters) {
        const query = `${first}${second}`;
        expect(found(query), query).toEqual(expected(query));
      }
    }
  });
});
