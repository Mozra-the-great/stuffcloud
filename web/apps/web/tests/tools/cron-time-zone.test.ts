import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserTimeZone,
  instantsOf,
  isTimeZone,
  listTimeZones,
  offsetAt,
  offsetsAround,
  wallTimeAt,
  wallToNumber,
} from '../../src/tools/cron/time-zone.ts';

const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isTimeZone', () => {
  it.each(['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Etc/GMT+5'])(
    'knows %s',
    (name) => {
      expect(isTimeZone(name)).toBe(true);
    },
  );

  it.each(['', 'Mars/Olympus', 'europe berlin', 'Europe/', '../etc/passwd'])(
    'does not know "%s"',
    (name) => {
      expect(isTimeZone(name)).toBe(false);
    },
  );
});

describe('listTimeZones', () => {
  it('starts with UTC and lists each zone once', () => {
    const zones = listTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toContain('Europe/Berlin');
    expect(zones).toContain('America/New_York');
    expect(zones.every(isTimeZone)).toBe(true);
  });

  it('also offers the new names of zones that browsers list under their old name', () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    intl.supportedValuesOf = (): string[] => ['Asia/Calcutta', 'Europe/Kiev'];
    try {
      const zones = listTimeZones();
      expect(zones).toContain('Asia/Calcutta');
      expect(zones).toContain('Asia/Kolkata');
      expect(zones).toContain('Europe/Kyiv');
      expect(zones).toEqual([...zones.slice(0, 1), ...zones.slice(1).sort()]);
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  it('falls back to a short list when the browser cannot list its zones', () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    intl.supportedValuesOf = undefined;
    try {
      const zones = listTimeZones();
      expect(zones[0]).toBe('UTC');
      expect(zones).toContain('Europe/Berlin');
      expect(zones.length).toBeLessThan(60);
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  it('falls back when listing throws, and leaves out a name that is not a zone', () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    intl.supportedValuesOf = (): string[] => {
      throw new RangeError('no');
    };
    try {
      expect(listTimeZones()).toContain('Asia/Tokyo');
      intl.supportedValuesOf = (): string[] => ['Europe/Berlin', 'UTC', 'Nowhere/Land'];
      const zones = listTimeZones();
      expect(zones).toContain('Europe/Berlin');
      expect(zones).not.toContain('Nowhere/Land');
      expect(zones.filter((name) => name === 'UTC')).toHaveLength(1);
    } finally {
      intl.supportedValuesOf = original;
    }
  });
});

describe('browserTimeZone', () => {
  it('is a zone the browser knows', () => {
    expect(isTimeZone(browserTimeZone())).toBe(true);
  });

  it('is UTC when the browser reports no usable zone', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    spy.mockReturnValue({ timeZone: 'Not/AZone' } as Intl.ResolvedDateTimeFormatOptions);
    expect(browserTimeZone()).toBe('UTC');
    spy.mockReturnValue({ timeZone: 'Asia/Tokyo' } as Intl.ResolvedDateTimeFormatOptions);
    expect(browserTimeZone()).toBe('Asia/Tokyo');
    spy.mockImplementation(() => {
      throw new Error('no');
    });
    expect(browserTimeZone()).toBe('UTC');
  });
});

describe('wallTimeAt', () => {
  it('reads the clock of a zone at an instant, winter and summer', () => {
    const winter = Date.UTC(2026, 0, 15, 12, 30, 45);
    expect(wallTimeAt(winter, 'UTC')).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 12,
      minute: 30,
      second: 45,
    });
    expect(wallTimeAt(winter, 'Europe/Berlin').hour).toBe(13);
    expect(wallTimeAt(winter, 'America/New_York').hour).toBe(7);
    const summer = Date.UTC(2026, 6, 15, 12, 30, 45);
    expect(wallTimeAt(summer, 'Europe/Berlin').hour).toBe(14);
    expect(wallTimeAt(summer, 'America/New_York').hour).toBe(8);
  });

  it('crosses midnight and the new year with the offset', () => {
    expect(wallTimeAt(Date.UTC(2026, 11, 31, 23, 30), 'Asia/Tokyo')).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
      hour: 8,
      minute: 30,
    });
    expect(wallTimeAt(Date.UTC(2026, 0, 1, 0, 0), 'Pacific/Honolulu')).toMatchObject({
      year: 2025,
      month: 12,
      day: 31,
      hour: 14,
    });
  });

  it('shows midnight as hour 0, not 24', () => {
    expect(wallTimeAt(Date.UTC(2026, 5, 1, 0, 0, 0), 'UTC').hour).toBe(0);
    expect(wallTimeAt(Date.UTC(2026, 5, 1, 22, 0, 0), 'Europe/Berlin').hour).toBe(0);
  });

  it('falls back to the epoch fields when a formatter leaves a part out', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    spy.mockReturnValue([{ type: 'literal', value: '-' }]);
    expect(wallTimeAt(0, 'Etc/GMT-3')).toEqual({
      year: 1970,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it('turns a wall time into a number on the wall-clock line', () => {
    expect(wallToNumber({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 5 })).toBe(
      Date.UTC(2026, 2, 29, 2, 30, 5),
    );
  });
});

describe('offsetAt', () => {
  it('is the distance of a zone from UTC, east positive', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15), 'UTC')).toBe(0);
    expect(offsetAt(Date.UTC(2026, 0, 15), 'Europe/Berlin')).toBe(HOUR);
    expect(offsetAt(Date.UTC(2026, 6, 15), 'Europe/Berlin')).toBe(2 * HOUR);
    expect(offsetAt(Date.UTC(2026, 0, 15), 'America/New_York')).toBe(-5 * HOUR);
    expect(offsetAt(Date.UTC(2026, 0, 15), 'Asia/Kolkata')).toBe(5.5 * HOUR);
    expect(offsetAt(Date.UTC(2026, 0, 15), 'Asia/Kathmandu')).toBe(5.75 * HOUR);
  });

  it('ignores the milliseconds of the instant', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15, 12, 0, 0, 999), 'Europe/Berlin')).toBe(HOUR);
  });
});

describe('offsetsAround', () => {
  it('is one offset on an ordinary day', () => {
    const offsets = offsetsAround(Date.UTC(2026, 0, 15), 'Europe/Berlin');
    expect(offsets).toEqual({ before: HOUR, after: HOUR, at: 0 });
    expect(offsetsAround(Date.UTC(2026, 0, 15), 'UTC')).toEqual({ before: 0, after: 0, at: 0 });
  });

  it('finds the second of a clock change forward, and back', () => {
    // Europe: the last Sunday of March and October at 01:00 UTC.
    expect(offsetsAround(Date.UTC(2026, 2, 29), 'Europe/Berlin')).toEqual({
      before: HOUR,
      after: 2 * HOUR,
      at: Date.UTC(2026, 2, 29, 1),
    });
    expect(offsetsAround(Date.UTC(2026, 9, 25), 'Europe/Berlin')).toEqual({
      before: 2 * HOUR,
      after: HOUR,
      at: Date.UTC(2026, 9, 25, 1),
    });
    // The days next to it see the change too (the window is three days wide).
    expect(offsetsAround(Date.UTC(2026, 2, 28), 'Europe/Berlin').at).toBe(Date.UTC(2026, 2, 29, 1));
    expect(offsetsAround(Date.UTC(2026, 2, 30), 'Europe/Berlin').at).toBe(Date.UTC(2026, 2, 29, 1));
  });

  it('finds a half-hour change (Lord Howe Island)', () => {
    // 2026-04-05 at 02:00 local (+11:00): the clock goes back 30 minutes to +10:30.
    const offsets = offsetsAround(Date.UTC(2026, 3, 5), 'Australia/Lord_Howe');
    expect(offsets.before).toBe(11 * HOUR);
    expect(offsets.after).toBe(10.5 * HOUR);
    expect(offsets.at).toBe(Date.UTC(2026, 3, 4, 15));
  });
});

describe('instantsOf', () => {
  const berlinSpring = offsetsAround(Date.UTC(2026, 2, 29), 'Europe/Berlin');
  const berlinAutumn = offsetsAround(Date.UTC(2026, 9, 25), 'Europe/Berlin');
  const wall = (hour: number, minute: number): number => Date.UTC(2026, 2, 29, hour, minute);

  it('is one instant on an ordinary day', () => {
    const offsets = offsetsAround(Date.UTC(2026, 0, 15), 'Europe/Berlin');
    expect(instantsOf(Date.UTC(2026, 0, 15, 9), offsets)).toEqual([Date.UTC(2026, 0, 15, 8)]);
  });

  it('is the one instant on either side of the clock change forward', () => {
    // 01:59:59 exists (+01:00), 02:00 to 02:59:59 do not, 03:00 exists (+02:00).
    expect(instantsOf(wall(1, 59) + 59_000, berlinSpring)).toEqual([
      Date.UTC(2026, 2, 29, 0, 59, 59),
    ]);
    expect(instantsOf(wall(3, 0), berlinSpring)).toEqual([Date.UTC(2026, 2, 29, 1, 0)]);
  });

  it('is nothing for a time the clock skips', () => {
    expect(instantsOf(wall(2, 0), berlinSpring)).toEqual([]);
    expect(instantsOf(wall(2, 30), berlinSpring)).toEqual([]);
    expect(instantsOf(wall(2, 59) + 59_000, berlinSpring)).toEqual([]);
  });

  it('is two instants, earlier first, for a time that happens twice', () => {
    const autumn = (hour: number, minute: number): number => Date.UTC(2026, 9, 25, hour, minute);
    // 02:00 to 02:59:59 happen at +02:00 and again at +01:00.
    expect(instantsOf(autumn(2, 30), berlinAutumn)).toEqual([
      Date.UTC(2026, 9, 25, 0, 30),
      Date.UTC(2026, 9, 25, 1, 30),
    ]);
    expect(instantsOf(autumn(2, 0), berlinAutumn)).toEqual([
      Date.UTC(2026, 9, 25, 0, 0),
      Date.UTC(2026, 9, 25, 1, 0),
    ]);
  });

  it('is one instant just before and just after the repeated hour', () => {
    const autumn = (hour: number, minute: number): number => Date.UTC(2026, 9, 25, hour, minute);
    expect(instantsOf(autumn(1, 59), berlinAutumn)).toEqual([Date.UTC(2026, 9, 24, 23, 59)]);
    expect(instantsOf(autumn(3, 0), berlinAutumn)).toEqual([Date.UTC(2026, 9, 25, 2, 0)]);
  });
});
