import { describe, expect, it } from 'vitest';
import { de } from '../../src/i18n/messages/de.ts';
import { en } from '../../src/i18n/messages/en.ts';
import {
  CATEGORIES,
  categoryName,
  convert,
  convertAll,
  DEFAULT_PRECISION,
  findCategory,
  findUnit,
  formatValue,
  localizeNumber,
  MAX_HITS,
  MAX_PRECISION,
  MIN_PRECISION,
  parseNumber,
  parsePrecision,
  searchUnits,
  unitName,
  type Category,
  type CategoryId,
  type Unit,
} from '../../src/tools/unit-converter/units.ts';

function categoryOf(id: CategoryId): Category {
  const category = findCategory(id);
  if (category === undefined) {
    throw new Error(`unknown category ${id}`);
  }
  return category;
}

function unitOf(category: Category, id: string): Unit {
  const unit = findUnit(category, id);
  if (unit === undefined) {
    throw new Error(`unknown unit ${id}`);
  }
  return unit;
}

/** The converted number, or the error code when the conversion is refused. */
function convertValue(
  categoryId: CategoryId,
  fromId: string,
  toId: string,
  value: number,
): number | string {
  const category = categoryOf(categoryId);
  const result = convert(category, unitOf(category, fromId), unitOf(category, toId), value);
  return result.ok ? result.value : result.error;
}

/** [category, from, value, to, expected]: exact definitions and well-known equivalences. */
const TABLE: readonly (readonly [CategoryId, string, number, string, number])[] = [
  // length
  ['length', 'km', 1, 'm', 1000],
  ['length', 'mi', 1, 'm', 1609.344],
  ['length', 'in', 1, 'mm', 25.4],
  ['length', 'ft', 100, 'm', 30.48],
  ['length', 'yd', 1, 'ft', 3],
  ['length', 'mi', 1, 'ft', 5280],
  ['length', 'nmi', 1, 'm', 1852],
  ['length', 'nm', 1e9, 'm', 1],
  ['length', 'um', 1e6, 'm', 1],
  ['length', 'cm', 100, 'm', 1],
  // mass
  ['mass', 'lb', 1, 'g', 453.59237],
  ['mass', 'oz', 1, 'g', 28.349523125],
  ['mass', 'st', 1, 'lb', 14],
  ['mass', 'ton', 1, 'lb', 2000],
  ['mass', 't', 1, 'kg', 1000],
  ['mass', 'kg', 1, 'g', 1000],
  ['mass', 'mg', 1e6, 'kg', 1],
  ['mass', 'ug', 1e9, 'kg', 1],
  // temperature, with the offsets
  ['temperature', 'c', 0, 'f', 32],
  ['temperature', 'c', 100, 'f', 212],
  ['temperature', 'c', -40, 'f', -40],
  ['temperature', 'f', -40, 'c', -40],
  ['temperature', 'c', 0, 'k', 273.15],
  ['temperature', 'k', 0, 'c', -273.15],
  ['temperature', 'k', 273.15, 'c', 0],
  ['temperature', 'f', 32, 'c', 0],
  ['temperature', 'f', 212, 'c', 100],
  ['temperature', 'f', 0, 'k', 255.3722222222222],
  ['temperature', 'k', 0, 'f', -459.67],
  ['temperature', 'r', 491.67, 'c', 0],
  ['temperature', 'c', 0, 'r', 491.67],
  ['temperature', 'r', 0, 'k', 0],
  ['temperature', 'c', 37, 'f', 98.6],
  ['temperature', 'k', 300, 'k', 300],
  // data: decimal and binary prefixes are different units
  ['data', 'kb', 1, 'byte', 1000],
  ['data', 'kib', 1, 'byte', 1024],
  ['data', 'mib', 1, 'kib', 1024],
  ['data', 'mb', 1, 'kb', 1000],
  ['data', 'gib', 1, 'byte', 1_073_741_824],
  ['data', 'gb', 1, 'byte', 1_000_000_000],
  ['data', 'gb', 1, 'gib', 0.9313225746154785],
  ['data', 'gib', 1, 'gb', 1.073741824],
  ['data', 'pib', 1, 'tib', 1024],
  ['data', 'pb', 1, 'tb', 1000],
  ['data', 'byte', 1, 'bit', 8],
  ['data', 'bit', 8, 'byte', 1],
  ['data', 'gbit', 1, 'mb', 125],
  ['data', 'mbit', 8, 'mb', 1],
  ['data', 'kbit', 1, 'bit', 1000],
  ['data', 'tbit', 1, 'gbit', 1000],
  ['data', 'mib', 1, 'kb', 1048.576],
  // time
  ['time', 'h', 1, 's', 3600],
  ['time', 'min', 1, 's', 60],
  ['time', 'd', 1, 'h', 24],
  ['time', 'wk', 1, 'd', 7],
  ['time', 'yr', 1, 'd', 365.25],
  ['time', 'ms', 1, 'us', 1000],
  ['time', 's', 1, 'ns', 1e9],
  // speed
  ['speed', 'kmh', 36, 'ms', 10],
  ['speed', 'ms', 1, 'kmh', 3.6],
  ['speed', 'mph', 1, 'kmh', 1.609344],
  ['speed', 'kn', 1, 'kmh', 1.852],
  ['speed', 'fts', 1, 'ms', 0.3048],
  // area
  ['area', 'ha', 1, 'm2', 10_000],
  ['area', 'ac', 1, 'm2', 4046.8564224],
  ['area', 'km2', 1, 'ha', 100],
  ['area', 'mi2', 1, 'ac', 640],
  ['area', 'ft2', 1, 'in2', 144],
  ['area', 'yd2', 1, 'ft2', 9],
  ['area', 'cm2', 10_000, 'm2', 1],
  ['area', 'mm2', 1e6, 'm2', 1],
  ['area', 'm2', 1, 'ft2', 10.763910416709722],
  // volume, US and imperial apart
  ['volume', 'gal', 1, 'qt', 4],
  ['volume', 'qt', 1, 'pt', 2],
  ['volume', 'gal', 1, 'floz', 128],
  ['volume', 'cup', 1, 'floz', 8],
  ['volume', 'tbsp', 1, 'tsp', 3],
  ['volume', 'tbsp', 1, 'floz', 0.5],
  ['volume', 'gal', 1, 'l', 3.785411784],
  ['volume', 'galimp', 1, 'l', 4.54609],
  ['volume', 'ptimp', 8, 'galimp', 1],
  ['volume', 'l', 1000, 'ml', 1e6],
  ['volume', 'm3', 1, 'l', 1000],
  ['volume', 'cm3', 1, 'ml', 1],
  ['volume', 'galimp', 1, 'gal', 1.2009499255],
];

describe('conversion table', () => {
  it.each(TABLE)('%s: %d %s is %d %s', (categoryId, from, value, to, expected) => {
    const actual = convertValue(categoryId, from, to, value);
    expect(typeof actual).toBe('number');
    expect(actual as number).toBeCloseTo(
      expected,
      8 - Math.max(0, Math.ceil(Math.log10(Math.abs(expected) || 1))),
    );
    // Within 12 significant digits, which the tool can show at most 15 of.
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(
      Math.abs(expected) * 1e-9 + 1e-12,
    );
  });

  it('shows the exact decimal for the cases people check by hand', () => {
    const shown = (categoryId: CategoryId, from: string, to: string, value: number): string =>
      formatValue(convertValue(categoryId, from, to, value) as number, 15);
    expect(shown('temperature', 'c', 'f', 100)).toBe('212');
    expect(shown('temperature', 'c', 'f', 37)).toBe('98.6');
    expect(shown('temperature', 'f', 'c', 98.6)).toBe('37');
    expect(shown('temperature', 'c', 'k', 0)).toBe('273.15');
    expect(shown('length', 'mi', 'km', 1)).toBe('1.609344');
    expect(shown('data', 'gib', 'mib', 1)).toBe('1024');
    expect(shown('data', 'byte', 'bit', 1)).toBe('8');
    expect(shown('speed', 'kmh', 'ms', 36)).toBe('10');
  });
});

describe('temperature offsets and absolute zero', () => {
  it('accepts absolute zero in every scale', () => {
    expect(convertValue('temperature', 'k', 'c', 0)).toBeCloseTo(-273.15, 12);
    expect(convertValue('temperature', 'c', 'k', -273.15)).toBe(0);
    expect(convertValue('temperature', 'f', 'k', -459.67)).toBe(0);
    expect(convertValue('temperature', 'r', 'k', 0)).toBe(0);
  });

  it.each([
    ['k', -0.0001],
    ['k', -1],
    ['c', -273.16],
    ['c', -300],
    ['f', -459.68],
    ['r', -0.0001],
  ])('refuses %s %d, which is below absolute zero', (unit, value) => {
    expect(convertValue('temperature', unit, 'k', value)).toBe('below-absolute-zero');
  });

  it('allows negative values where nothing forbids them', () => {
    expect(convertValue('length', 'm', 'km', -500)).toBe(-0.5);
    expect(convertValue('temperature', 'c', 'f', -10)).toBe(14);
  });
});

describe('overflow', () => {
  it('reports a value that overflows on the way to the base unit', () => {
    expect(convertValue('data', 'pib', 'bit', 1e308)).toBe('overflow');
  });

  it('reports a result that overflows on the way out', () => {
    expect(convertValue('length', 'km', 'nm', 1e300)).toBe('overflow');
  });

  it('returns the value itself for the same unit, without rounding noise', () => {
    expect(convertValue('length', 'km', 'km', 0.1 + 0.2)).toBe(0.1 + 0.2);
  });
});

describe('every pair of units', () => {
  const values = [1, 0.001, 123_456.789, 3.5e7];

  it.each(CATEGORIES.map((category) => [category.id, category] as const))(
    '%s: there and back again returns the value',
    (_id, category) => {
      for (const from of category.units) {
        for (const to of category.units) {
          for (const value of values) {
            const there = convert(category, from, to, value);
            expect(there.ok).toBe(true);
            if (!there.ok) {
              continue;
            }
            const back = convert(category, to, from, there.value);
            expect(back.ok).toBe(true);
            if (back.ok) {
              expect(Math.abs(back.value - value)).toBeLessThanOrEqual(
                Math.abs(value) * 1e-12 + 1e-12,
              );
            }
          }
        }
      }
    },
  );

  it.each(CATEGORIES.map((category) => [category.id, category] as const))(
    '%s: converting through a third unit gives the same answer',
    (_id, category) => {
      const [first, second, third] = category.units;
      if (second === undefined || third === undefined) {
        throw new Error('too few units');
      }
      const direct = convert(category, first, third, 42);
      const middle = convert(category, first, second, 42);
      expect(direct.ok && middle.ok).toBe(true);
      if (direct.ok && middle.ok) {
        const via = convert(category, second, third, middle.value);
        expect(via.ok && Math.abs(via.value - direct.value) <= Math.abs(direct.value) * 1e-12).toBe(
          true,
        );
      }
    },
  );

  it('keeps order: a bigger value is never converted into a smaller one (linear units)', () => {
    for (const category of CATEGORIES) {
      for (const from of category.units) {
        for (const to of category.units) {
          const small = convert(category, from, to, 10);
          const large = convert(category, from, to, 11);
          if (small.ok && large.ok) {
            expect(large.value).toBeGreaterThan(small.value);
          }
        }
      }
    }
  });
});

describe('the unit tables', () => {
  it('has the eight categories of the issue', () => {
    expect(CATEGORIES.map((category) => category.id)).toEqual([
      'length',
      'mass',
      'temperature',
      'data',
      'time',
      'speed',
      'area',
      'volume',
    ]);
  });

  it('has unique ids within a category, names in both languages and sensible defaults', () => {
    for (const category of CATEGORIES) {
      const ids = category.units.map((unit) => unit.id);
      expect(new Set(ids).size, category.id).toBe(ids.length);
      expect(en[category.nameKey], category.nameKey).toBeDefined();
      expect(de[category.nameKey], category.nameKey).toBeDefined();
      const [from, to] = category.defaults;
      expect(from).not.toBe(to);
      expect(ids).toContain(from);
      expect(ids).toContain(to);
      for (const unit of category.units) {
        expect(unit.nameKey).toBe(`unit.${category.id}.${unit.id}`);
        expect(unit.symbol).not.toBe('');
        expect(unitName(unit, 'en')).not.toBe('');
        expect(unitName(unit, 'de')).not.toBe('');
        expect(unit.fromBase(unit.toBase(7))).toBeCloseTo(7, 9);
      }
    }
  });

  it('has a minimum only for temperature', () => {
    expect(
      CATEGORIES.filter((category) => category.minimumBase !== undefined).map(
        (category) => category.id,
      ),
    ).toEqual(['temperature']);
  });

  it('finds categories and units, and nothing else', () => {
    const length = categoryOf('length');
    expect(findUnit(length, 'km')?.symbol).toBe('km');
    expect(findUnit(length, 'zz')).toBeUndefined();
    expect(findCategory('nope')).toBeUndefined();
  });

  it('names units and categories in the language asked for', () => {
    const length = categoryOf('length');
    expect(categoryName(length, 'en')).toBe('Length');
    expect(categoryName(length, 'de')).toBe('Länge');
    expect(unitName(unitOf(length, 'ft'), 'en')).toBe('Foot');
    expect(unitName(unitOf(length, 'ft'), 'de')).toBe('Fuß');
  });

  it('reads the plural message of a name by its fallback form', () => {
    // A unit name is plain text; the helper still copes with a plural message.
    const fake: Unit = { ...unitOf(categoryOf('length'), 'm'), nameKey: 'units.search.count' };
    expect(unitName(fake, 'en')).toBe('{count} units found');
  });
});

describe('convertAll', () => {
  it('converts into every unit in table order, flagging the ones that fail', () => {
    const temperature = categoryOf('temperature');
    const kelvin = unitOf(temperature, 'k');
    const all = convertAll(temperature, kelvin, 273.15);
    expect(all.map((entry) => entry.unit.id)).toEqual(['c', 'f', 'k', 'r']);
    expect(all.map((entry) => entry.result.ok)).toEqual([true, true, true, true]);
    const celsius = unitOf(temperature, 'c');
    const below = convertAll(temperature, celsius, -300);
    expect(below.every((entry) => !entry.result.ok)).toBe(true);
  });
});

describe('parseNumber', () => {
  it.each([
    ['12', 12],
    ['  12  ', 12],
    ['+12', 12],
    ['-12', -12],
    ['\u221212', -12],
    ['12.5', 12.5],
    ['12,5', 12.5],
    ['.5', 0.5],
    [',5', 0.5],
    ['5.', 5],
    ['5,', 5],
    ['1 234.5', 1234.5],
    ['1_234,5', 1234.5],
    ['1\u00a0234', 1234],
    ['1\u202f234', 1234],
    ['1e3', 1000],
    ['1E-3', 0.001],
    ['-2.5e+2', -250],
    ['0', 0],
    ['-0', -0],
  ])('reads %j as %d', (text, expected) => {
    const parsed = parseNumber(text);
    expect(parsed).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'syntax'],
    ['1.2.3', 'syntax'],
    ['1,2,3', 'syntax'],
    ['1.234,5', 'syntax'],
    ['1,234.5', 'syntax'],
    ['--1', 'syntax'],
    ['1e', 'syntax'],
    ['e5', 'syntax'],
    ['0x10', 'syntax'],
    ['Infinity', 'syntax'],
    ['NaN', 'syntax'],
    ['1/2', 'syntax'],
    ['12 km', 'syntax'],
    ['.', 'syntax'],
    ['1e999', 'range'],
    ['-1e999', 'range'],
  ])('refuses %j as %s', (text, error) => {
    expect(parseNumber(text)).toEqual({ ok: false, error });
  });
});

describe('precision', () => {
  it.each([
    ['6', 6],
    ['1', 1],
    ['15', 15],
    ['0', 1],
    ['-3', 1],
    ['16', 15],
    ['99', 15],
    ['7.4', 7],
    ['7.5', 8],
    ['', DEFAULT_PRECISION],
    ['x', DEFAULT_PRECISION],
    ['Infinity', DEFAULT_PRECISION],
  ])('turns %j into %i', (text, expected) => {
    expect(parsePrecision(text)).toBe(expected);
  });

  it('has the range the interface names', () => {
    expect([MIN_PRECISION, DEFAULT_PRECISION, MAX_PRECISION]).toEqual([1, 6, 15]);
  });
});

describe('formatValue', () => {
  it.each([
    [1 / 3, 6, '0.333333'],
    [1 / 3, 15, '0.333333333333333'],
    [2 / 3, 3, '0.667'],
    [1234.5678, 6, '1234.57'],
    [1234.5678, 15, '1234.5678'],
    [1e6, 3, '1000000'],
    [1500, 1, '2000'],
    [100, 1, '100'],
    [0, 6, '0'],
    [-0, 6, '0'],
    [0.1 + 0.2, 15, '0.3'],
    [0.1 + 0.2, 17, '0.3'],
    [-2.5, 6, '-2.5'],
    [123_456_789_012_345, 15, '123456789012345'],
    [999_999_999_999_999, 15, '999999999999999'],
    [1e15, 6, '1e+15'],
    [1.5e21, 6, '1.5e+21'],
    [-1.5e21, 6, '-1.5e+21'],
    [123_456_789e10, 3, '1.23e+18'],
    [999_999_999_999_999.9, 15, '1e+15'],
    [0.000001, 6, '0.000001'],
    [0.0000012345, 2, '0.0000012'],
    [0.00000099, 6, '9.9e-7'],
    [1e-7, 1, '1e-7'],
    [-2.5e-9, 2, '-2.5e-9'],
    [1.2345e-10, 3, '1.23e-10'],
  ])('writes %d with %d digits as %s', (value, precision, expected) => {
    expect(formatValue(value, precision)).toBe(expected);
  });

  it('keeps the precision inside its range', () => {
    expect(formatValue(1 / 3, 0)).toBe('0.3');
    expect(formatValue(1 / 3, 99)).toBe('0.333333333333333');
    expect(formatValue(1 / 3, 2.4)).toBe('0.33');
  });

  it('writes the German decimal comma and leaves English alone', () => {
    expect(localizeNumber('0.5', 'de')).toBe('0,5');
    expect(localizeNumber('1.5e+21', 'de')).toBe('1,5e+21');
    expect(localizeNumber('-12', 'de')).toBe('-12');
    expect(localizeNumber('0.5', 'en')).toBe('0.5');
  });
});

describe('search', () => {
  const ids = (query: string): string[] =>
    searchUnits(query).map((hit) => `${hit.category.id}/${hit.unit.id}`);

  it('finds a unit by its symbol, exact match first', () => {
    expect(ids('km')[0]).toBe('length/km');
    expect(ids('GiB')[0]).toBe('data/gib');
    expect(ids('gb')[0]).toBe('data/gb');
    expect(ids('fl oz')).toEqual(['volume/floz']);
  });

  it('finds a unit by name in English and in German, in either spelling', () => {
    expect(ids('mile')[0]).toBe('length/mi');
    expect(ids('Meile')[0]).toBe('length/mi');
    expect(ids('metre')[0]).toBe('length/m');
    expect(ids('meter')[0]).toBe('length/m');
    expect(ids('litre')[0]).toBe('volume/l');
    expect(ids('liter')[0]).toBe('volume/l');
    expect(ids('kilometre')[0]).toBe('length/km');
    expect(ids('FUSS')).toContain('length/ft');
    expect(ids('Fuß')).toContain('length/ft');
  });

  it('puts names that start with the query before names that only contain it', () => {
    const hits = ids('kilometer');
    expect(hits[0]).toBe('length/km');
    expect(hits.indexOf('speed/kmh')).toBeLessThan(hits.indexOf('area/km2'));
  });

  it('finds by category name, in both languages', () => {
    expect(ids('temperature')).toEqual([
      'temperature/c',
      'temperature/f',
      'temperature/k',
      'temperature/r',
    ]);
    expect(ids('Temperatur')).toHaveLength(4);
    expect(ids('Länge')).toContain('length/nmi');
    expect(ids('Länge')).not.toContain('mass/kg');
  });

  it('needs every word of the query', () => {
    expect(ids('square mile')).toEqual(['area/mi2']);
    expect(ids('mile square')).toEqual(['area/mi2']);
    expect(ids('gallon imperial')).toEqual(['volume/galimp']);
    expect(ids('square zzz')).toEqual([]);
  });

  it('accepts accents and capitals', () => {
    expect(ids('MIKROMETER')).toContain('length/um');
    expect(ids('mikro')).toEqual(expect.arrayContaining(['length/um', 'mass/ug', 'time/us']));
  });

  it('returns nothing for an empty query or one that matches nothing', () => {
    expect(searchUnits('')).toEqual([]);
    expect(searchUnits('   ')).toEqual([]);
    expect(searchUnits('zzzzzz')).toEqual([]);
  });

  it('shows at most twelve hits', () => {
    expect(MAX_HITS).toBe(12);
    expect(searchUnits('meter')).toHaveLength(MAX_HITS);
    expect(searchUnits('e').length).toBeLessThanOrEqual(MAX_HITS);
  });

  it('can find every unit by its own symbol and by its English name', () => {
    for (const category of CATEGORIES) {
      for (const unit of category.units) {
        const bySymbol = searchUnits(unit.symbol);
        expect(
          bySymbol.some((hit) => hit.unit === unit && hit.category === category),
          `${category.id}/${unit.id} by symbol ${unit.symbol}`,
        ).toBe(true);
        const name = unitName(unit, 'en');
        expect(
          searchUnits(name).some((hit) => hit.unit === unit && hit.category === category),
          `${category.id}/${unit.id} by name ${name}`,
        ).toBe(true);
      }
    }
  });
});
