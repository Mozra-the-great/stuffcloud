import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/tools/timestamp/relative.ts';
import { formatInstant, parseInstant } from '../../src/tools/timestamp/timestamp.ts';

const JUNE_FIRST = Date.UTC(2026, 5, 1, 10, 0, 0);

describe('parseInstant: an ISO text with an offset', () => {
  it.each([
    ['2026-06-01T10:00:00Z', JUNE_FIRST],
    ['2026-06-01T10:00:00z', JUNE_FIRST],
    ['2026-06-01t10:00:00Z', JUNE_FIRST],
    ['2026-06-01 10:00:00 Z', JUNE_FIRST],
    ['2026-06-01T12:00:00+02:00', JUNE_FIRST],
    ['2026-06-01T12:00:00+0200', JUNE_FIRST],
    ['2026-06-01T12:00:00+02', JUNE_FIRST],
    ['2026-06-01T04:30:00-05:30', JUNE_FIRST],
    ['2026-06-01T04:30:00-0530', JUNE_FIRST],
    ['2026-06-01T23:59:00+13:59', JUNE_FIRST],
    ['2026-06-01T00:00:00-23:59', Date.UTC(2026, 5, 1, 23, 59, 0)],
  ])('reads %s', (text, expected) => {
    // The zone of the page does not matter when the text has its own offset.
    for (const zone of ['UTC', 'Europe/Berlin', 'America/New_York']) {
      expect(parseInstant(text, 'auto', zone), zone).toEqual({
        ok: true,
        ms: expected,
        kind: 'iso',
        ambiguous: false,
      });
    }
  });

  it('refuses an offset that is not a time of day, at the edge', () => {
    expect(parseInstant('2026-06-01T10:00:00+24:00', 'auto', 'UTC')).toEqual({
      ok: false,
      error: 'offset',
    });
    expect(parseInstant('2026-06-01T10:00:00+23:60', 'auto', 'UTC')).toEqual({
      ok: false,
      error: 'offset',
    });
    expect(parseInstant('2026-06-01T10:00:00-24:00', 'auto', 'UTC')).toEqual({
      ok: false,
      error: 'offset',
    });
    expect(parseInstant('2026-06-01T10:00:00+23:59', 'auto', 'UTC').ok).toBe(true);
    expect(parseInstant('2026-06-01T10:00:00+00:59', 'auto', 'UTC').ok).toBe(true);
  });
});

describe('parseInstant: an ISO text without an offset', () => {
  it('reads the clock in UTC when that is the zone', () => {
    expect(parseInstant('2026-06-01T10:00:00', 'auto', 'UTC')).toEqual({
      ok: true,
      ms: JUNE_FIRST,
      kind: 'iso',
      ambiguous: false,
    });
    expect(parseInstant('2026-06-01', 'auto', 'UTC')).toEqual({
      ok: true,
      ms: Date.UTC(2026, 5, 1),
      kind: 'iso',
      ambiguous: false,
    });
  });

  it('reads the clock in the chosen zone', () => {
    expect(parseInstant('2026-06-01T12:00:00', 'auto', 'Europe/Berlin')).toEqual({
      ok: true,
      ms: JUNE_FIRST,
      kind: 'iso',
      ambiguous: false,
    });
    expect(parseInstant('2026-01-01T11:00:00', 'auto', 'Europe/Berlin')).toEqual({
      ok: true,
      ms: Date.UTC(2026, 0, 1, 10, 0, 0),
      kind: 'iso',
      ambiguous: false,
    });
  });

  it('takes the earlier instant of a clock time that happens twice and says so', () => {
    expect(parseInstant('2026-10-25T02:30:00', 'auto', 'Europe/Berlin')).toEqual({
      ok: true,
      ms: Date.UTC(2026, 9, 25, 0, 30, 0),
      kind: 'iso',
      ambiguous: true,
    });
  });

  it('refuses a clock time that does not happen', () => {
    expect(parseInstant('2026-03-29T02:30:00', 'auto', 'Europe/Berlin')).toEqual({
      ok: false,
      error: 'gap',
    });
  });
});

describe('parseInstant: the shape of an ISO text', () => {
  it.each([
    'x2026-06-01',
    ' x2026-06-01',
    '2026-06-01x',
    '2026-06-01T10:00:00Zx',
    '12026-06-01',
    '026-06-01',
    '2026-6-01',
    '2026-06-1',
    '2026-06-01T1:00',
    '2026-06-01T10',
    '2026-06-01T10:00:00.',
    '2026-06-01T10:00:00.1234567890',
    '2026-06-01T10:00:00+2',
    '2026-06-01T10:00:00+02:0',
    '2026-06-01T10:00:00 +',
    '2026/06/01',
  ])('refuses %s as a format error', (text) => {
    const result = parseInstant(text, 'auto', 'UTC');
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).not.toBe('range');
  });

  it('keeps the fraction of a second as milliseconds, cut after three digits', () => {
    const ms = (text: string): number | undefined => {
      const result = parseInstant(text, 'auto', 'UTC');
      return result.ok ? result.ms : undefined;
    };
    expect(ms('2026-06-01T10:00:00.5Z')).toBe(JUNE_FIRST + 500);
    expect(ms('2026-06-01T10:00:00,25Z')).toBe(JUNE_FIRST + 250);
    expect(ms('2026-06-01T10:00:00.123456789Z')).toBe(JUNE_FIRST + 123);
    expect(ms('2026-06-01T10:00:00.001Z')).toBe(JUNE_FIRST + 1);
  });
});

describe('formatInstant: the years that have a clock', () => {
  const first = ((): number => {
    const date = new Date(0);
    date.setUTCFullYear(1, 0, 1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  })();
  const last = ((): number => {
    const date = new Date(0);
    date.setUTCFullYear(9999, 11, 31);
    date.setUTCHours(23, 59, 59, 999);
    return date.getTime();
  })();

  it('shows the clock from the first moment of year 1 to the last of year 9999', () => {
    expect(formatInstant(first, 'UTC', 'en').isoZone).toBe('0001-01-01T00:00:00+00:00');
    expect(formatInstant(last, 'UTC', 'en').isoZone).toBe('9999-12-31T23:59:59.999+00:00');
    expect(formatInstant(first, 'UTC', 'en').local).toBeDefined();
    expect(formatInstant(last, 'UTC', 'en').local).toBeDefined();
  });

  it('shows no clock one millisecond outside of it', () => {
    for (const outside of [first - 1, last + 1]) {
      const formats = formatInstant(outside, 'UTC', 'en');
      expect(formats.isoZone).toBeUndefined();
      expect(formats.local).toBeUndefined();
      expect(formats.isoUtc).toBeDefined();
    }
  });
});

describe('relativeTime: where one unit gives way to the next', () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const MONTH = 30.436875 * DAY;
  const YEAR = 365.2425 * DAY;

  it('switches at one minute, one hour and one day exactly', () => {
    expect(relativeTime(MINUTE - 1, 'en')).toBe('in 59 seconds');
    expect(relativeTime(MINUTE, 'en')).toBe('in 1 minute');
    expect(relativeTime(HOUR - 1, 'en')).toBe('in 59 minutes');
    expect(relativeTime(HOUR, 'en')).toBe('in 1 hour');
    expect(relativeTime(DAY - 1, 'en')).toBe('in 23 hours');
    expect(relativeTime(DAY, 'en')).toBe('tomorrow');
  });

  it('switches to months at the average month and to years at the average year, and not a millisecond earlier', () => {
    expect(relativeTime(MONTH - 1, 'en')).toBe('in 30 days');
    expect(relativeTime(MONTH, 'en')).toBe('next month');
    expect(relativeTime(-(MONTH - 1), 'en')).toBe('30 days ago');
    expect(relativeTime(-MONTH, 'en')).toBe('last month');
    expect(relativeTime(YEAR - 1, 'en')).toBe('in 11 months');
    expect(relativeTime(YEAR, 'en')).toBe('next year');
    expect(relativeTime(-(YEAR - 1), 'en')).toBe('11 months ago');
    expect(relativeTime(-YEAR, 'en')).toBe('last year');
  });
});
