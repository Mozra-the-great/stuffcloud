import { describe, expect, it } from 'vitest';
import { matchingDays, parseCron, type CronSchedule } from '../../src/tools/cron/cron.ts';
import { MAX_RUNS, nextRuns } from '../../src/tools/cron/next-runs.ts';
import { wallTimeAt } from '../../src/tools/cron/time-zone.ts';

function schedule(text: string): CronSchedule {
  const result = parseCron(text);
  if (!result.ok) {
    throw new Error(`${text}: ${JSON.stringify(result.errors)}`);
  }
  return result.schedule;
}

/** The runs as `YYYY-MM-DDTHH:MM:SSZ` (UTC), easy to compare. */
function runs(
  text: string,
  from: number,
  count: number,
  timeZone = 'UTC',
): { readonly list: string[]; readonly exhausted: boolean } {
  const result = nextRuns(schedule(text), { from, count, timeZone });
  return {
    list: result.runs.map((instant) => new Date(instant).toISOString().slice(0, 19) + 'Z'),
    exhausted: result.exhausted,
  };
}

const JUNE_1 = Date.UTC(2026, 5, 1, 10, 0, 0);

describe('nextRuns in UTC', () => {
  it('lists the runs after the start, in order', () => {
    expect(runs('*/20 * * * *', JUNE_1, 4)).toEqual({
      list: [
        '2026-06-01T10:20:00Z',
        '2026-06-01T10:40:00Z',
        '2026-06-01T11:00:00Z',
        '2026-06-01T11:20:00Z',
      ],
      exhausted: false,
    });
  });

  it('does not count a run at the very moment of the start, but one a second later', () => {
    expect(runs('0 10 * * *', JUNE_1, 1).list).toEqual(['2026-06-02T10:00:00Z']);
    expect(runs('0 10 * * *', JUNE_1 - 1000, 1).list).toEqual(['2026-06-01T10:00:00Z']);
    // Milliseconds of the start do not matter: 10:00:00.500 is already after 10:00:00.
    expect(runs('0 10 * * *', JUNE_1 + 500, 1).list).toEqual(['2026-06-02T10:00:00Z']);
  });

  it('keeps to the minute of a five-field expression: the second is 0', () => {
    expect(runs('* * * * *', JUNE_1 + 30_000, 2).list).toEqual([
      '2026-06-01T10:01:00Z',
      '2026-06-01T10:02:00Z',
    ]);
  });

  it('uses the seconds field of the six- and seven-field forms', () => {
    expect(runs('*/20 * * * * *', JUNE_1, 3).list).toEqual([
      '2026-06-01T10:00:20Z',
      '2026-06-01T10:00:40Z',
      '2026-06-01T10:01:00Z',
    ]);
    expect(runs('15 30 9 * * * 2026', JUNE_1, 2).list).toEqual([
      '2026-06-02T09:30:15Z',
      '2026-06-03T09:30:15Z',
    ]);
  });

  it('goes over the end of a day, a month and a year', () => {
    expect(runs('0 0 * * *', Date.UTC(2026, 11, 30, 12), 3).list).toEqual([
      '2026-12-31T00:00:00Z',
      '2027-01-01T00:00:00Z',
      '2027-01-02T00:00:00Z',
    ]);
    expect(runs('0 0 1 * *', Date.UTC(2026, 0, 31, 12), 2).list).toEqual([
      '2026-02-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
  });

  it('runs on the listed weekdays only', () => {
    // 2026-06-01 is a Monday.
    expect(runs('0 9 * * 2,4', JUNE_1, 4).list).toEqual([
      '2026-06-02T09:00:00Z',
      '2026-06-04T09:00:00Z',
      '2026-06-09T09:00:00Z',
      '2026-06-11T09:00:00Z',
    ]);
    expect(runs('0 9 * * MON-FRI', Date.UTC(2026, 5, 5, 12), 3).list).toEqual([
      '2026-06-08T09:00:00Z',
      '2026-06-09T09:00:00Z',
      '2026-06-10T09:00:00Z',
    ]);
  });

  it('runs on the listed months only, and in the start month before the start day', () => {
    expect(runs('0 0 15 3,9 *', JUNE_1, 3).list).toEqual([
      '2026-09-15T00:00:00Z',
      '2027-03-15T00:00:00Z',
      '2027-09-15T00:00:00Z',
    ]);
    expect(runs('0 0 1,20 6 *', JUNE_1, 3).list).toEqual([
      '2026-06-20T00:00:00Z',
      '2027-06-01T00:00:00Z',
      '2027-06-20T00:00:00Z',
    ]);
  });

  it('follows the day rule: either day, or both', () => {
    // The 13th or a Friday.
    expect(runs('0 0 13 * 5', JUNE_1, 4).list).toEqual([
      '2026-06-05T00:00:00Z',
      '2026-06-12T00:00:00Z',
      '2026-06-13T00:00:00Z',
      '2026-06-19T00:00:00Z',
    ]);
    // Odd days that are Mondays.
    expect(runs('0 0 */2 * 1', JUNE_1, 3).list).toEqual([
      '2026-06-15T00:00:00Z',
      '2026-06-29T00:00:00Z',
      '2026-07-13T00:00:00Z',
    ]);
  });

  it('knows the Quartz days', () => {
    expect(runs('0 0 12 L * ?', JUNE_1, 3).list).toEqual([
      '2026-06-30T12:00:00Z',
      '2026-07-31T12:00:00Z',
      '2026-08-31T12:00:00Z',
    ]);
    expect(runs('0 0 12 ? * FRI#3', JUNE_1, 2).list).toEqual([
      '2026-06-19T12:00:00Z',
      '2026-07-17T12:00:00Z',
    ]);
  });

  it('restricts the years', () => {
    expect(runs('0 0 0 1 1 ? 2028,2030', JUNE_1, 5)).toEqual({
      list: ['2028-01-01T00:00:00Z', '2030-01-01T00:00:00Z'],
      exhausted: true,
    });
    expect(runs('0 0 0 1 1 ? 2026/2', JUNE_1, 3).list).toEqual([
      '2028-01-01T00:00:00Z',
      '2030-01-01T00:00:00Z',
      '2032-01-01T00:00:00Z',
    ]);
  });

  it('finds a leap day, years away', () => {
    expect(runs('0 0 29 2 *', JUNE_1, 3).list).toEqual([
      '2028-02-29T00:00:00Z',
      '2032-02-29T00:00:00Z',
      '2036-02-29T00:00:00Z',
    ]);
    expect(runs('0 0 29 2 1', Date.UTC(2026, 0, 1), 1).list).toEqual(['2026-02-02T00:00:00Z']);
  });

  it('knows when a schedule never runs', () => {
    expect(runs('0 0 30 2 *', JUNE_1, 3)).toEqual({ list: [], exhausted: true });
    expect(runs('0 0 31 4,6,9,11 *', JUNE_1, 3)).toEqual({ list: [], exhausted: true });
    expect(runs('0 0 0 1 1 ? 2020', JUNE_1, 3)).toEqual({ list: [], exhausted: true });
  });

  it('says it is exhausted only when it has fewer runs than asked for', () => {
    expect(runs('0 0 0 1 1 ? 2027', JUNE_1, 1)).toEqual({
      list: ['2027-01-01T00:00:00Z'],
      exhausted: false,
    });
    expect(runs('0 0 0 1 1 ? 2027', JUNE_1, 2).exhausted).toBe(true);
  });

  it('stops at the last year the field allows', () => {
    const result = runs('0 0 1 1 *', Date.UTC(2198, 5, 1), 5);
    expect(result).toEqual({ list: ['2199-01-01T00:00:00Z'], exhausted: true });
  });

  it('keeps the count between 1 and the maximum, whole', () => {
    expect(runs('* * * * *', JUNE_1, 0).list).toHaveLength(1);
    expect(runs('* * * * *', JUNE_1, -5).list).toHaveLength(1);
    expect(runs('* * * * *', JUNE_1, 2.9).list).toHaveLength(2);
    expect(runs('* * * * *', JUNE_1, MAX_RUNS + 1).list).toHaveLength(MAX_RUNS);
    expect(runs('* * * * *', JUNE_1, 1000).list).toHaveLength(MAX_RUNS);
  });

  it('handles every second of a day quickly', () => {
    const started = performance.now();
    expect(runs('* * * * * *', JUNE_1, 50).list).toHaveLength(50);
    expect(runs('* * * * * *', Date.UTC(2026, 5, 1, 23, 59, 59), 3).list).toEqual([
      '2026-06-02T00:00:00Z',
      '2026-06-02T00:00:01Z',
      '2026-06-02T00:00:02Z',
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('nextRuns in other time zones', () => {
  it('reads the fields as the clock of the zone', () => {
    expect(runs('0 9 * * *', JUNE_1, 2, 'Europe/Berlin').list).toEqual([
      '2026-06-02T07:00:00Z',
      '2026-06-03T07:00:00Z',
    ]);
    expect(runs('0 9 * * *', Date.UTC(2026, 0, 10), 1, 'Europe/Berlin').list).toEqual([
      '2026-01-10T08:00:00Z',
    ]);
    expect(runs('30 9 * * *', JUNE_1, 1, 'Asia/Kolkata').list).toEqual(['2026-06-02T04:00:00Z']);
    expect(runs('0 9 * * *', JUNE_1, 1, 'America/New_York').list).toEqual(['2026-06-01T13:00:00Z']);
  });

  it('takes the day and weekday of the zone, not of UTC', () => {
    // Monday 00:30 in Tokyo is still Sunday 15:30 UTC.
    expect(runs('30 0 * * 1', JUNE_1, 1, 'Asia/Tokyo').list).toEqual(['2026-06-07T15:30:00Z']);
    expect(runs('0 0 1 7 *', JUNE_1, 1, 'Pacific/Honolulu').list).toEqual(['2026-07-01T10:00:00Z']);
  });

  it('starts from the day of the zone when it differs from the day in UTC', () => {
    // 2026-06-01 23:00 UTC is already June 2nd in Tokyo (08:00).
    expect(runs('0 9 * * *', Date.UTC(2026, 5, 1, 23), 1, 'Asia/Tokyo').list).toEqual([
      '2026-06-02T00:00:00Z',
    ]);
  });

  it('skips a time the clock skips (Berlin, 2026-03-29)', () => {
    expect(runs('30 2 * * *', Date.UTC(2026, 2, 27, 12), 4, 'Europe/Berlin').list).toEqual([
      '2026-03-28T01:30:00Z',
      // No 02:30 on the 29th.
      '2026-03-30T00:30:00Z',
      '2026-03-31T00:30:00Z',
      '2026-04-01T00:30:00Z',
    ]);
    // Every half hour: the clock jumps from 02:00 to 03:00 and the real time goes on evenly.
    expect(runs('*/30 * * * *', Date.UTC(2026, 2, 29, 0, 15), 4, 'Europe/Berlin').list).toEqual([
      '2026-03-29T00:30:00Z',
      '2026-03-29T01:00:00Z',
      '2026-03-29T01:30:00Z',
      '2026-03-29T02:00:00Z',
    ]);
  });

  it('runs a time that happens twice once (Berlin, 2026-10-25)', () => {
    expect(runs('30 2 * * *', Date.UTC(2026, 9, 24, 12), 3, 'Europe/Berlin').list).toEqual([
      '2026-10-25T00:30:00Z',
      '2026-10-26T01:30:00Z',
      '2026-10-27T01:30:00Z',
    ]);
  });

  it('runs a schedule that runs in every hour in both passes of the repeated hour', () => {
    // New York, 2026-11-01: 01:00 to 01:59 happen at -04:00 and again at -05:00.
    expect(runs('*/30 * * * *', Date.UTC(2026, 10, 1, 4, 45), 5, 'America/New_York').list).toEqual([
      '2026-11-01T05:00:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:00:00Z',
      '2026-11-01T06:30:00Z',
      '2026-11-01T07:00:00Z',
    ]);
    // A fixed hour runs once.
    expect(runs('0 1 * * *', Date.UTC(2026, 10, 1, 3), 2, 'America/New_York').list).toEqual([
      '2026-11-01T05:00:00Z',
      '2026-11-02T06:00:00Z',
    ]);
  });

  it('keeps the runs in order across a clock change', () => {
    const result = nextRuns(schedule('*/15 * * * *'), {
      from: Date.UTC(2026, 9, 24, 22),
      count: 50,
      timeZone: 'Europe/Berlin',
    });
    const sorted = [...result.runs].sort((a, b) => a - b);
    expect(result.runs).toEqual(sorted);
    expect(new Set(result.runs).size).toBe(result.runs.length);
  });
});

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('invariants of nextRuns (seeded random schedules)', () => {
  const zones = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'];

  function pick<T>(random: () => number, items: readonly T[]): T {
    return items[Math.floor(random() * items.length)] as T;
  }

  function field(random: () => number, min: number, max: number): string {
    const value = (): number => min + Math.floor(random() * (max - min + 1));
    switch (Math.floor(random() * 6)) {
      case 0:
        return '*';
      case 1:
        return String(value());
      case 2:
        return `${value()},${value()},${value()}`;
      case 3: {
        const a = value();
        const b = a + Math.floor(random() * (max - a + 1));
        return `${a}-${b}`;
      }
      case 4:
        return `*/${1 + Math.floor(random() * Math.min(10, max - min + 1))}`;
      default:
        return `${value()}/${1 + Math.floor(random() * 5)}`;
    }
  }

  it('runs ascend, lie after the start, and match every field in the zone', () => {
    const random = generator(20_261_119);
    let checked = 0;
    for (let round = 0; round < 150; round += 1) {
      const text = [
        field(random, 0, 59),
        field(random, 0, 59),
        field(random, 0, 23),
        field(random, 1, 28),
        field(random, 1, 12),
        field(random, 0, 6),
      ].join(' ');
      const parsed = schedule(text);
      const timeZone = pick(random, zones);
      const from = Date.UTC(2026, 0, 1) + Math.floor(random() * 3 * 365 * 86_400_000);
      const result = nextRuns(parsed, { from, count: 20, timeZone });
      let previous = from;
      for (const instant of result.runs) {
        expect(instant, text).toBeGreaterThan(previous);
        previous = instant;
        const wall = wallTimeAt(instant, timeZone);
        expect(parsed.second?.values ?? [0], text).toContain(wall.second);
        expect(parsed.minute.values, text).toContain(wall.minute);
        expect(parsed.hour.values, text).toContain(wall.hour);
        expect(parsed.month.values, text).toContain(wall.month);
        expect(matchingDays(parsed, wall.year, wall.month), text).toContain(wall.day);
        checked += 1;
      }
      expect(result.exhausted || result.runs.length === 20, text).toBe(true);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('misses no run: every minute-aligned instant that matches is listed', () => {
    const random = generator(7);
    for (let round = 0; round < 25; round += 1) {
      const text = [field(random, 0, 59), field(random, 0, 23), '*', '*', field(random, 0, 6)].join(
        ' ',
      );
      const parsed = schedule(text);
      const from = Date.UTC(2026, 5, 1);
      const result = nextRuns(parsed, { from, count: MAX_RUNS, timeZone: 'UTC' });
      // Scan the same span minute by minute.
      expect(result.exhausted, text).toBe(false);
      const until = result.runs.at(-1) ?? from;
      const expected: number[] = [];
      for (
        let instant = from + 60_000;
        instant <= until && expected.length < MAX_RUNS;
        instant += 60_000
      ) {
        const at = new Date(instant);
        if (
          parsed.minute.values.includes(at.getUTCMinutes()) &&
          parsed.hour.values.includes(at.getUTCHours()) &&
          matchingDays(parsed, at.getUTCFullYear(), at.getUTCMonth() + 1).includes(at.getUTCDate())
        ) {
          expected.push(instant);
        }
      }
      expect(result.runs.slice(0, expected.length), text).toEqual(expected);
    }
  });
});
