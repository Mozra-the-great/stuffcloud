import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/tools/timestamp/relative.ts';
import {
  MAX_INPUT_LENGTH,
  formatInstant,
  parseInstant,
  type EpochUnit,
  type ParseErrorCode,
} from '../../src/tools/timestamp/timestamp.ts';

const NOON = Date.UTC(2026, 5, 1, 10, 0, 0);

function ms(input: string, unit: EpochUnit = 'auto', zone = 'UTC'): number {
  const result = parseInstant(input, unit, zone);
  if (!result.ok) {
    throw new Error(`expected ${input} to parse, got ${result.error}`);
  }
  return result.ms;
}

function error(input: string, zone = 'UTC'): ParseErrorCode | undefined {
  const result = parseInstant(input, 'auto', zone);
  return result.ok ? undefined : result.error;
}

describe('epoch numbers', () => {
  it('reads seconds and milliseconds, and says which', () => {
    expect(parseInstant('1780308000', 'auto', 'UTC')).toEqual({
      ok: true,
      ms: NOON,
      kind: 'seconds',
      ambiguous: false,
    });
    expect(parseInstant('1780308000000', 'auto', 'UTC')).toEqual({
      ok: true,
      ms: NOON,
      kind: 'milliseconds',
      ambiguous: false,
    });
  });

  it('switches from seconds to milliseconds at 100 billion', () => {
    expect(parseInstant('99999999999', 'auto', 'UTC')).toMatchObject({ kind: 'seconds' });
    expect(parseInstant('100000000000', 'auto', 'UTC')).toMatchObject({
      kind: 'milliseconds',
      ms: 100_000_000_000,
    });
    expect(parseInstant('-99999999999', 'auto', 'UTC')).toMatchObject({ kind: 'seconds' });
    expect(parseInstant('-100000000000', 'auto', 'UTC')).toMatchObject({ kind: 'milliseconds' });
  });

  it('lets the unit decide when it is given', () => {
    expect(ms('1780308000', 'milliseconds')).toBe(1_780_308_000);
    expect(ms('1780308000000', 'seconds', 'UTC')).toBe(1_780_308_000_000_000);
    expect(ms('5', 'seconds')).toBe(5000);
    expect(ms('5', 'milliseconds')).toBe(5);
  });

  it('reads fractions and signs, and never -0', () => {
    expect(ms('1.5')).toBe(1500);
    expect(ms('1780308000.123')).toBe(NOON + 123);
    expect(ms('-1')).toBe(-1000);
    expect(ms('+7')).toBe(7000);
    expect(ms('0.0004')).toBe(0);
    expect(Object.is(ms('-0'), 0)).toBe(true);
    expect(Object.is(ms('-0.0001'), 0)).toBe(true);
    expect(ms('1.5', 'milliseconds')).toBe(2);
  });

  it('accepts what a date can hold and refuses one more', () => {
    expect(ms('8640000000000000', 'milliseconds')).toBe(8.64e15);
    expect(ms('-8640000000000000', 'milliseconds')).toBe(-8.64e15);
    expect(ms('8640000000000', 'seconds')).toBe(8.64e15);
    expect(error('8640000000000001')).toBe('range');
    expect(parseInstant('8640000000001', 'seconds', 'UTC')).toEqual({ ok: false, error: 'range' });
    expect(parseInstant('-8640000000000001', 'milliseconds', 'UTC')).toEqual({
      ok: false,
      error: 'range',
    });
    expect(error('99999999999999999999')).toBe('range');
  });
});

describe('ISO 8601', () => {
  it('reads a date and time with Z, an offset, or none (UTC)', () => {
    expect(ms('2026-06-01T10:00:00Z')).toBe(NOON);
    expect(ms('2026-06-01t10:00:00z')).toBe(NOON);
    expect(ms('2026-06-01 10:00:00')).toBe(NOON);
    expect(ms('2026-06-01T10:00')).toBe(NOON);
    expect(ms('2026-06-01')).toBe(Date.UTC(2026, 5, 1));
    expect(ms('2026-06-01T12:00:00+02:00')).toBe(NOON);
    expect(ms('2026-06-01T12:00:00+0200')).toBe(NOON);
    expect(ms('2026-06-01T12:00:00+02')).toBe(NOON);
    expect(ms('2026-06-01T04:30:00-0530')).toBe(NOON);
    expect(ms('2026-06-01T10:00:00 +00:00')).toBe(NOON);
    expect(ms('  2026-06-01T10:00:00Z  ')).toBe(NOON);
    expect(ms('2026-06-01Z')).toBe(Date.UTC(2026, 5, 1));
  });

  it('reads fractions of a second, cut to milliseconds', () => {
    expect(ms('2026-06-01T10:00:00.5Z')).toBe(NOON + 500);
    expect(ms('2026-06-01T10:00:00,25Z')).toBe(NOON + 250);
    expect(ms('2026-06-01T10:00:00.123456789Z')).toBe(NOON + 123);
  });

  it('keeps years below 100 as written (not 1900 plus)', () => {
    expect(new Date(ms('0050-01-01T00:00:00Z')).toISOString()).toBe('0050-01-01T00:00:00.000Z');
    expect(new Date(ms('0000-01-01T00:00:00Z')).toISOString()).toBe('0000-01-01T00:00:00.000Z');
    expect(new Date(ms('9999-12-31T23:59:59Z')).toISOString()).toBe('9999-12-31T23:59:59.000Z');
  });

  it('knows which February days exist', () => {
    expect(error('2028-02-29')).toBeUndefined();
    expect(error('2027-02-29')).toBe('date');
    expect(error('1900-02-29')).toBe('date');
    expect(error('2000-02-29')).toBeUndefined();
    expect(error('2026-04-30')).toBeUndefined();
    expect(error('2026-04-31')).toBe('date');
    expect(error('2026-01-31')).toBeUndefined();
    expect(error('2026-01-32')).toBe('date');
    expect(error('2026-00-10')).toBe('date');
    expect(error('2026-13-10')).toBe('date');
    expect(error('2026-06-00')).toBe('date');
  });

  it('refuses a time that cannot be on a clock, and an offset that cannot be', () => {
    expect(error('2026-06-01T23:59:59')).toBeUndefined();
    expect(error('2026-06-01T24:00:00')).toBe('time');
    expect(error('2026-06-01T10:60')).toBe('time');
    expect(error('2026-06-01T10:00:60')).toBe('time');
    expect(error('2026-06-01T10:00:00+23:59')).toBeUndefined();
    expect(error('2026-06-01T10:00:00+24:00')).toBe('offset');
    expect(error('2026-06-01T10:00:00+05:60')).toBe('offset');
    expect(error('2026-06-01T10:00:00-23:59')).toBeUndefined();
  });

  it('refuses text that is not a number or an ISO date', () => {
    for (const text of [
      'yesterday',
      '2026-6-1',
      '06/01/2026',
      '2026-06-01T',
      '1e5',
      '0x10',
      '1,5',
      'NaN',
    ]) {
      expect(error(text), text).toBe('format');
    }
  });

  it('reports empty and too long input', () => {
    expect(error('')).toBe('empty');
    expect(error('   ')).toBe('empty');
    expect(error('1'.repeat(MAX_INPUT_LENGTH + 1))).toBe('too-long');
    expect(error('1'.repeat(MAX_INPUT_LENGTH))).not.toBe('too-long');
  });
});

describe('a time without an offset is read in the chosen zone', () => {
  it('uses the offset in force on that day', () => {
    expect(ms('2026-06-01T12:00:00', 'auto', 'Europe/Berlin')).toBe(NOON);
    expect(ms('2026-01-15T11:00:00', 'auto', 'Europe/Berlin')).toBe(Date.UTC(2026, 0, 15, 10));
    expect(ms('2026-06-01T15:30:00', 'auto', 'Asia/Kolkata')).toBe(Date.UTC(2026, 5, 1, 10));
    expect(ms('2026-06-01T06:00:00', 'auto', 'America/New_York')).toBe(NOON);
  });

  it('also reads years below 100 in a zone (regression: they were read as 19xx)', () => {
    const moment = ms('0050-06-01T12:00:00', 'auto', 'Europe/Berlin');
    expect(new Date(moment).getUTCFullYear()).toBe(50);
    expect(formatInstant(moment, 'Europe/Berlin', 'en').isoZone).toMatch(
      /^0050-06-01T12:00:00[+-]\d{2}:\d{2}$/,
    );
  });

  it('prefers an offset written in the text to the zone', () => {
    expect(ms('2026-06-01T10:00:00Z', 'auto', 'America/New_York')).toBe(NOON);
    expect(ms('2026-06-01T10:00:00+00:00', 'auto', 'Asia/Tokyo')).toBe(NOON);
  });

  it('refuses a clock time that the clocks skip', () => {
    expect(error('2026-03-29T02:30:00', 'Europe/Berlin')).toBe('gap');
    expect(error('2026-03-29T01:59:59', 'Europe/Berlin')).toBeUndefined();
    expect(error('2026-03-29T03:00:00', 'Europe/Berlin')).toBeUndefined();
  });

  it('takes the earlier moment of a clock time that happens twice, and says so', () => {
    expect(parseInstant('2026-10-25T02:30:00', 'auto', 'Europe/Berlin')).toEqual({
      ok: true,
      ms: Date.UTC(2026, 9, 25, 0, 30),
      kind: 'iso',
      ambiguous: true,
    });
    expect(parseInstant('2026-10-25T03:30:00', 'auto', 'Europe/Berlin')).toMatchObject({
      ambiguous: false,
      ms: Date.UTC(2026, 9, 25, 2, 30),
    });
  });
});

describe('formatInstant', () => {
  it('writes every format', () => {
    expect(formatInstant(NOON, 'UTC', 'en')).toEqual({
      seconds: '1780308000',
      milliseconds: '1780308000000',
      isoUtc: '2026-06-01T10:00:00.000Z',
      http: 'Mon, 01 Jun 2026 10:00:00 GMT',
      isoZone: '2026-06-01T10:00:00+00:00',
      local: 'Monday, June 1, 2026 at 10:00:00 AM UTC',
    });
  });

  it('shows the clock of the zone, with its offset', () => {
    expect(formatInstant(NOON, 'Europe/Berlin', 'en').isoZone).toBe('2026-06-01T12:00:00+02:00');
    expect(formatInstant(Date.UTC(2026, 0, 15, 10), 'Europe/Berlin', 'en').isoZone).toBe(
      '2026-01-15T11:00:00+01:00',
    );
    expect(formatInstant(NOON, 'Asia/Kolkata', 'en').isoZone).toBe('2026-06-01T15:30:00+05:30');
    expect(formatInstant(NOON, 'America/New_York', 'en').isoZone).toBe('2026-06-01T06:00:00-04:00');
    expect(formatInstant(NOON, 'Pacific/Kiritimati', 'en').isoZone).toBe(
      '2026-06-02T00:00:00+14:00',
    );
  });

  it('writes the date in words in the language asked for', () => {
    expect(formatInstant(NOON, 'Europe/Berlin', 'de').local).toContain('Montag, 1. Juni 2026');
    expect(formatInstant(NOON, 'Europe/Berlin', 'en').local).toContain('Monday, June 1, 2026');
  });

  it('keeps fractions of a second', () => {
    const formats = formatInstant(NOON + 250, 'UTC', 'en');
    expect(formats.seconds).toBe('1780308000.250');
    expect(formats.milliseconds).toBe('1780308000250');
    expect(formats.isoUtc).toBe('2026-06-01T10:00:00.250Z');
    expect(formats.isoZone).toBe('2026-06-01T10:00:00.250+00:00');
  });

  it('handles moments before 1970', () => {
    const formats = formatInstant(-1500, 'UTC', 'en');
    expect(formats.seconds).toBe('-1.500');
    expect(formats.isoUtc).toBe('1969-12-31T23:59:58.500Z');
    expect(formats.isoZone).toBe('1969-12-31T23:59:58.500+00:00');
    expect(formatInstant(0, 'UTC', 'en').seconds).toBe('0');
  });

  it('shows no zone clock outside the years 1 to 9999', () => {
    const late = formatInstant(8.64e15, 'UTC', 'en');
    expect(late.isoZone).toBeUndefined();
    expect(late.local).toBeUndefined();
    expect(late.isoUtc).toBe('+275760-09-13T00:00:00.000Z');
    expect(formatInstant(Date.UTC(9999, 11, 31, 23, 59, 59), 'UTC', 'en').isoZone).toBeDefined();
    const early = formatInstant(new Date('0000-06-01T00:00:00Z').getTime(), 'UTC', 'en');
    expect(early.isoZone).toBeUndefined();
    expect(formatInstant(new Date('0001-01-01T00:00:00Z').getTime(), 'UTC', 'en').isoZone).toBe(
      '0001-01-01T00:00:00+00:00',
    );
  });

  it('writes an old local offset in whole minutes', () => {
    // Before 1893 Amsterdam kept a clock 19 minutes and 32 seconds ahead of Greenwich.
    const text = formatInstant(Date.UTC(1850, 0, 1), 'Europe/Amsterdam', 'en').isoZone;
    expect(text).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('round-trips through the parser (property over generated moments)', () => {
    let state = 0xabcdef;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };
    for (let round = 0; round < 300; round += 1) {
      const moment = (next() % 4_000_000_000) * 1000 - 1_000_000_000_000 + (next() % 1000);
      const formats = formatInstant(moment, 'UTC', 'en');
      expect(ms(formats.isoUtc), formats.isoUtc).toBe(moment);
      expect(ms(formats.isoZone ?? ''), formats.isoZone).toBe(moment);
      expect(ms(formats.milliseconds, 'milliseconds')).toBe(moment);
      expect(ms(formats.seconds, 'seconds')).toBe(moment);
    }
  });
});

describe('relativeTime', () => {
  const second = 1000;
  const minute = 60 * second;
  const hour = 60 * minute;
  const day = 24 * hour;

  it('says now, and counts seconds', () => {
    expect(relativeTime(0, 'en')).toBe('now');
    expect(relativeTime(-30 * second, 'en')).toBe('30 seconds ago');
    expect(relativeTime(30 * second, 'en')).toBe('in 30 seconds');
    expect(relativeTime(-59_999, 'en')).toBe('59 seconds ago');
  });

  it('picks the largest unit that fits once, and cuts instead of rounding', () => {
    expect(relativeTime(-minute, 'en')).toBe('1 minute ago');
    expect(relativeTime(-(hour - 1), 'en')).toBe('59 minutes ago');
    expect(relativeTime(-hour, 'en')).toBe('1 hour ago');
    expect(relativeTime(-(day - 1), 'en')).toBe('23 hours ago');
    expect(relativeTime(2 * day, 'en')).toBe('in 2 days');
    expect(relativeTime(-29 * day, 'en')).toBe('29 days ago');
    expect(relativeTime(-45 * day, 'en')).toBe('last month');
    expect(relativeTime(-200 * day, 'en')).toBe('6 months ago');
    expect(relativeTime(-400 * day, 'en')).toBe('last year');
    expect(relativeTime(3 * 366 * day, 'en')).toBe('in 3 years');
  });

  it('speaks German', () => {
    expect(relativeTime(-2 * hour, 'de')).toBe('vor 2 Stunden');
    expect(relativeTime(day, 'de')).toBe('morgen');
  });
});
