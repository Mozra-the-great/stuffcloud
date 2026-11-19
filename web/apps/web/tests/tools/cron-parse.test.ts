import { describe, expect, it } from 'vitest';
import {
  daysInMonth,
  MAX_LENGTH,
  matchingDays,
  parseCron,
  weekdayOf,
  YEAR_MAX,
  YEAR_MIN,
  type CronError,
  type CronField,
  type CronSchedule,
} from '../../src/tools/cron/cron.ts';

function schedule(text: string): CronSchedule {
  const result = parseCron(text);
  if (!result.ok) {
    throw new Error(`${text}: ${JSON.stringify(result.errors)}`);
  }
  return result.schedule;
}

function errors(text: string): readonly CronError[] {
  const result = parseCron(text);
  if (result.ok) {
    throw new Error(`${text} should not parse`);
  }
  return result.errors;
}

function values(field: CronField | undefined): readonly number[] {
  return field?.values ?? [];
}

describe('the three dialects', () => {
  it('reads five fields as minute hour day-of-month month day-of-week', () => {
    const s = schedule('5 4 3 2 1');
    expect(s.dialect).toBe('standard');
    expect(s.second).toBeUndefined();
    expect(s.year).toBeUndefined();
    expect(values(s.minute)).toEqual([5]);
    expect(values(s.hour)).toEqual([4]);
    expect(values(s.dayOfMonth)).toEqual([3]);
    expect(values(s.month)).toEqual([2]);
    expect(values(s.dayOfWeek)).toEqual([1]);
  });

  it('reads six fields with the seconds first', () => {
    const s = schedule('6 5 4 3 2 1');
    expect(s.dialect).toBe('seconds');
    expect(values(s.second)).toEqual([6]);
    expect(values(s.minute)).toEqual([5]);
    expect(s.year).toBeUndefined();
  });

  it('reads seven fields with the year last', () => {
    const s = schedule('6 5 4 3 2 1 2030');
    expect(s.dialect).toBe('quartz');
    expect(values(s.second)).toEqual([6]);
    expect(values(s.year)).toEqual([2030]);
  });

  it.each([1, 2, 3, 4, 8, 9])('refuses %i fields and says how many it found', (count) => {
    const text = Array.from({ length: count }, () => '*').join(' ');
    expect(errors(text)).toEqual([{ code: 'field-count', count }]);
  });

  it('takes any run of white space between fields and around the text', () => {
    const s = schedule('  0\t5   *  * *  ');
    expect(s.normalized).toBe('0 5 * * *');
  });
});

describe('macros', () => {
  it.each([
    ['@yearly', '0 0 1 1 *'],
    ['@annually', '0 0 1 1 *'],
    ['@monthly', '0 0 1 * *'],
    ['@weekly', '0 0 * * 0'],
    ['@daily', '0 0 * * *'],
    ['@midnight', '0 0 * * *'],
    ['@hourly', '0 * * * *'],
    ['@DAILY', '0 0 * * *'],
  ])('%s is %s', (macro, expanded) => {
    const s = schedule(macro);
    expect(s.normalized).toBe(expanded);
    expect(s.macro).toBe(macro.toLowerCase());
    expect(s.dialect).toBe('standard');
  });

  it('has no macro for a plain expression', () => {
    expect(schedule('* * * * *').macro).toBeUndefined();
  });

  it('refuses @reboot: it has no times', () => {
    expect(errors('@reboot')).toEqual([{ code: 'reboot', token: '@reboot' }]);
  });

  it('refuses an unknown name and a macro with more text after it', () => {
    expect(errors('@sometimes')).toEqual([{ code: 'unknown-macro', token: '@sometimes' }]);
    expect(errors('@daily 5')).toEqual([{ code: 'unknown-macro', token: '@daily' }]);
    expect(errors('@reboot 5')).toEqual([{ code: 'unknown-macro', token: '@reboot' }]);
  });
});

describe('values, lists, ranges and steps', () => {
  it('expands a star to the whole field and marks it as a wildcard', () => {
    const s = schedule('* * * * *');
    expect(s.minute.values).toHaveLength(60);
    expect(s.hour.values).toHaveLength(24);
    expect(s.dayOfMonth.values).toHaveLength(31);
    expect(s.month.values).toHaveLength(12);
    expect(s.dayOfWeek.values).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.minute.wildcard).toBe(true);
    expect(s.minute.star).toBe(true);
  });

  it('sorts and de-duplicates a list', () => {
    expect(values(schedule('30,5,30,10 * * * *').minute)).toEqual([5, 10, 30]);
  });

  it('expands a range, ends included', () => {
    expect(values(schedule('* 9-12 * * *').hour)).toEqual([9, 10, 11, 12]);
    expect(values(schedule('* 7-7 * * *').hour)).toEqual([7]);
  });

  it.each([
    ['*/15 * * * *', 'minute', [0, 15, 30, 45]],
    ['10/20 * * * *', 'minute', [10, 30, 50]],
    ['0-30/10 * * * *', 'minute', [0, 10, 20, 30]],
    ['* */6 * * *', 'hour', [0, 6, 12, 18]],
    ['* * */10 * *', 'dayOfMonth', [1, 11, 21, 31]],
    ['* * * */4 *', 'month', [1, 5, 9]],
  ] as const)('expands the step in %s', (text, name, expected) => {
    expect(values(schedule(text)[name])).toEqual(expected);
  });

  it('takes a step of one as a wildcard, and 0-59 too', () => {
    expect(schedule('*/1 * * * *').minute.wildcard).toBe(true);
    expect(schedule('0-59 * * * *').minute.wildcard).toBe(true);
    expect(schedule('0-58 * * * *').minute.wildcard).toBe(false);
  });

  it('accepts the largest step, the size of the field', () => {
    expect(values(schedule('*/60 * * * *').minute)).toEqual([0]);
    expect(values(schedule('* */24 * * *').hour)).toEqual([0]);
  });

  it('reads names in any case, also in ranges, lists and steps', () => {
    expect(values(schedule('0 0 * jan,Mar,DEC *').month)).toEqual([1, 3, 12]);
    expect(values(schedule('0 0 * * mon-fri').dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(values(schedule('0 0 * * SUN').dayOfWeek)).toEqual([0]);
    expect(values(schedule('0 0 * feb-apr/2 *').month)).toEqual([2, 4]);
  });
});

describe('the day of week', () => {
  it('takes 0 and 7 as Sunday', () => {
    expect(values(schedule('* * * * 0').dayOfWeek)).toEqual([0]);
    expect(values(schedule('* * * * 7').dayOfWeek)).toEqual([0]);
    expect(values(schedule('* * * * 5-7').dayOfWeek)).toEqual([0, 5, 6]);
    expect(values(schedule('* * * * 0-7').dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(schedule('* * * * 0-7').dayOfWeek.wildcard).toBe(true);
  });

  it('lets a star step stop at Saturday', () => {
    expect(values(schedule('* * * * */2').dayOfWeek)).toEqual([0, 2, 4, 6]);
    expect(values(schedule('* * * * 5/2').dayOfWeek)).toEqual([0, 5]);
  });
});

describe('Quartz extras (six and seven fields)', () => {
  it('reads ? as "any" in the two day fields', () => {
    const s = schedule('0 0 12 ? * MON');
    expect(s.dayOfMonth.wildcard).toBe(true);
    expect(s.dayOfMonth.star).toBe(true);
    expect(s.dayRule).toBe('dow');
    expect(schedule('0 0 12 1 * ?').dayRule).toBe('dom');
  });

  it('reads L, L-n, LW and nW in the day of month', () => {
    const s = schedule('0 0 0 L,L-3,LW,15W * ?');
    expect(s.dayOfMonth.items).toEqual([
      { kind: 'last' },
      { kind: 'last-offset', offset: 3 },
      { kind: 'last-weekday' },
      { kind: 'nearest-weekday', day: 15 },
    ]);
    expect(s.dayOfMonth.wildcard).toBe(false);
    expect(s.dayOfMonth.values).toEqual([]);
  });

  it('reads nL and n#k in the day of week, by number or name', () => {
    const s = schedule('0 0 0 ? * 5L,MON#2,7#5');
    expect(s.dayOfWeek.items).toEqual([
      { kind: 'last-dow', weekday: 5 },
      { kind: 'nth-dow', weekday: 1, nth: 2 },
      { kind: 'nth-dow', weekday: 0, nth: 5 },
    ]);
    expect(schedule('0 0 0 ? * FRIL').dayOfWeek.items).toEqual([{ kind: 'last-dow', weekday: 5 }]);
  });

  it('allows a special next to plain values', () => {
    const s = schedule('0 0 0 1,L * ?');
    expect(s.dayOfMonth.values).toEqual([1]);
    expect(s.dayOfMonth.items).toHaveLength(2);
  });

  it.each([
    ['0 0 L * *', 'dayOfMonth', 'L'],
    ['0 0 15W * *', 'dayOfMonth', '15W'],
    ['0 0 L-2 * *', 'dayOfMonth', 'L-2'],
    ['0 0 ? * *', 'dayOfMonth', '?'],
    ['0 0 * * ?', 'dayOfWeek', '?'],
    ['0 0 * * 5L', 'dayOfWeek', '5L'],
    ['0 0 * * 5#2', 'dayOfWeek', '5#2'],
  ] as const)('refuses %s with five fields', (text, field, token) => {
    expect(errors(text)).toEqual([{ code: 'unsupported-special', field, token }]);
  });

  it('checks the numbers of the extras', () => {
    expect(errors('0 0 0 32W * ?')).toEqual([
      { code: 'out-of-range', field: 'dayOfMonth', token: '32W', min: 1, max: 31 },
    ]);
    expect(errors('0 0 0 0W * ?')).toEqual([
      { code: 'out-of-range', field: 'dayOfMonth', token: '0W', min: 1, max: 31 },
    ]);
    expect(errors('0 0 0 L-0 * ?')).toEqual([
      { code: 'out-of-range', field: 'dayOfMonth', token: 'L-0', min: 1, max: 30 },
    ]);
    expect(errors('0 0 0 L-31 * ?')).toEqual([
      { code: 'out-of-range', field: 'dayOfMonth', token: 'L-31', min: 1, max: 30 },
    ]);
    expect(errors('0 0 0 ? * 8L')).toEqual([
      { code: 'out-of-range', field: 'dayOfWeek', token: '8L', min: 0, max: 7 },
    ]);
    expect(errors('0 0 0 ? * 8#1')).toEqual([
      { code: 'out-of-range', field: 'dayOfWeek', token: '8#1', min: 0, max: 7 },
    ]);
    expect(errors('0 0 0 ? * 5#0')).toEqual([
      { code: 'bad-nth', field: 'dayOfWeek', token: '5#0', min: 1, max: 5 },
    ]);
    expect(errors('0 0 0 ? * 5#6')).toEqual([
      { code: 'bad-nth', field: 'dayOfWeek', token: '5#6', min: 1, max: 5 },
    ]);
    expect(errors('0 0 0 ? * XYZL')).toEqual([
      { code: 'syntax', field: 'dayOfWeek', token: 'XYZL' },
    ]);
    expect(errors('0 0 0 ? * XYZ#2')).toEqual([
      { code: 'syntax', field: 'dayOfWeek', token: 'XYZ#2' },
    ]);
  });

  it('has no ? or L outside the two day fields', () => {
    expect(errors('0 0 ? * * *')).toEqual([{ code: 'syntax', field: 'hour', token: '?' }]);
    expect(errors('0 0 0 * L ?')).toEqual([{ code: 'syntax', field: 'month', token: 'L' }]);
  });
});

describe('what is wrong, field by field', () => {
  it('refuses an empty text', () => {
    expect(errors('')).toEqual([{ code: 'empty' }]);
    expect(errors('   \t ')).toEqual([{ code: 'empty' }]);
  });

  it('refuses a text longer than the limit, and takes one of exactly that length', () => {
    expect(errors('*'.repeat(MAX_LENGTH + 1))).toEqual([{ code: 'too-long', max: MAX_LENGTH }]);
    const longList = `${Array.from({ length: 200 }, () => '1').join(',')} * * * *`;
    expect(longList.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(parseCron(longList).ok).toBe(true);
  });

  it('refuses an empty part of a list', () => {
    expect(errors('1,,2 * * * *')).toEqual([{ code: 'empty-item', field: 'minute', token: '' }]);
    expect(errors('* 1, * * *')).toEqual([{ code: 'empty-item', field: 'hour', token: '' }]);
    expect(errors('* * ,1 * *')).toEqual([{ code: 'empty-item', field: 'dayOfMonth', token: '' }]);
  });

  it.each([
    ['60 * * * *', 'minute', '60', 0, 59],
    ['* 24 * * *', 'hour', '24', 0, 23],
    ['* * 0 * *', 'dayOfMonth', '0', 1, 31],
    ['* * 32 * *', 'dayOfMonth', '32', 1, 31],
    ['* * * 0 *', 'month', '0', 1, 12],
    ['* * * 13 *', 'month', '13', 1, 12],
    ['* * * * 8', 'dayOfWeek', '8', 0, 7],
    ['* 5-24 * * *', 'hour', '5-24', 0, 23],
    ['30-70 * * * *', 'minute', '30-70', 0, 59],
    ['61/5 * * * *', 'minute', '61/5', 0, 59],
    ['0 0 0 * * * 1969', 'year', '1969', YEAR_MIN, YEAR_MAX],
    ['0 0 0 * * * 2200', 'year', '2200', YEAR_MIN, YEAR_MAX],
  ] as const)('refuses %s: out of range', (text, field, token, min, max) => {
    expect(errors(text)).toEqual([{ code: 'out-of-range', field, token, min, max }]);
  });

  it('takes the first and the last value of every field', () => {
    expect(parseCron('0 0 1 1 0').ok).toBe(true);
    expect(parseCron('59 23 31 12 7').ok).toBe(true);
    expect(parseCron('59 59 23 31 12 7 2199').ok).toBe(true);
    expect(parseCron('0 0 0 1 1 0 1970').ok).toBe(true);
  });

  it('refuses a range that ends before it starts', () => {
    expect(errors('30-10 * * * *')).toEqual([
      { code: 'range-order', field: 'minute', token: '30-10' },
    ]);
    expect(errors('* * * * FRI-MON')).toEqual([
      { code: 'range-order', field: 'dayOfWeek', token: 'FRI-MON' },
    ]);
  });

  it('refuses a step of 0 and a step larger than the field', () => {
    expect(errors('*/0 * * * *')).toEqual([{ code: 'step-zero', field: 'minute', token: '*/0' }]);
    expect(errors('*/61 * * * *')).toEqual([
      { code: 'step-too-large', field: 'minute', token: '*/61', max: 60 },
    ]);
    expect(errors('* * * * */8')).toEqual([
      { code: 'step-too-large', field: 'dayOfWeek', token: '*/8', max: 7 },
    ]);
    expect(errors('* * * */13 *')).toEqual([
      { code: 'step-too-large', field: 'month', token: '*/13', max: 12 },
    ]);
  });

  it.each([
    ['abc * * * *', 'minute', 'abc'],
    ['* * * XYZ *', 'month', 'XYZ'],
    ['* * * * FOO', 'dayOfWeek', 'FOO'],
    ['* * * * JAN', 'dayOfWeek', 'JAN'],
    ['MON * * * *', 'minute', 'MON'],
    ['-5 * * * *', 'minute', '-5'],
    ['5- * * * *', 'minute', '5-'],
    ['1-2-3 * * * *', 'minute', '1-2-3'],
    ['*/ * * * *', 'minute', '*/'],
    ['*/x * * * *', 'minute', '*/x'],
    ['5/ * * * *', 'minute', '5/'],
    ['*-5 * * * *', 'minute', '*-5'],
    ['1.5 * * * *', 'minute', '1.5'],
    ['+5 * * * *', 'minute', '+5'],
    ['12345 * * * *', 'minute', '12345'],
    ['H * * * *', 'minute', 'H'],
  ] as const)('refuses %s: not a value, range or step', (text, field, token) => {
    expect(errors(text)).toEqual([{ code: 'syntax', field, token }]);
  });

  it('refuses a range with a step written the wrong way round', () => {
    expect(errors('5/2-4 * * * *')).toEqual([{ code: 'syntax', field: 'minute', token: '5/2-4' }]);
  });

  it('reports every field that is wrong, in field order', () => {
    expect(errors('60 25 * 13 *')).toEqual([
      { code: 'out-of-range', field: 'minute', token: '60', min: 0, max: 59 },
      { code: 'out-of-range', field: 'hour', token: '25', min: 0, max: 23 },
      { code: 'out-of-range', field: 'month', token: '13', min: 1, max: 12 },
    ]);
  });

  it('reports every wrong part of a list', () => {
    expect(errors('1,70,x * * * *').map((error) => error.token)).toEqual(['70', 'x']);
  });
});

describe('which days a schedule runs on', () => {
  it.each([
    ['* * * * *', 'all'],
    ['0 0 0 * * ?', 'all'],
    ['* * 1 * *', 'dom'],
    ['* * 1,15 * *', 'dom'],
    ['* * * * 1', 'dow'],
    ['* * * * MON-FRI', 'dow'],
    ['* * 13 * 5', 'or'],
    ['* * 1-31 * 5', 'or'],
    ['* * */2 * 1', 'and'],
    ['* * 13 * */2', 'and'],
    ['* * * * 0-7', 'dow'],
  ] as const)('the day rule of %s is %s', (text, rule) => {
    expect(schedule(text).dayRule).toBe(rule);
  });

  it('knows the days of every month, also in leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('knows the weekday of a date (Sunday = 0)', () => {
    expect(weekdayOf(2026, 11, 22)).toBe(0);
    expect(weekdayOf(2026, 11, 23)).toBe(1);
    expect(weekdayOf(2000, 1, 1)).toBe(6);
  });

  it('lists every day when nothing restricts them', () => {
    expect(matchingDays(schedule('* * * * *'), 2026, 2)).toHaveLength(28);
    expect(matchingDays(schedule('* * * * *'), 2024, 2)).toHaveLength(29);
  });

  it('lists the days of the month, and not the ones the month does not have', () => {
    expect(matchingDays(schedule('* * 1,15,31 * *'), 2026, 4)).toEqual([1, 15]);
    expect(matchingDays(schedule('* * 29-31 * *'), 2026, 2)).toEqual([]);
    expect(matchingDays(schedule('* * 29 * *'), 2024, 2)).toEqual([29]);
  });

  it('lists the weekdays of a month', () => {
    // November 2026 starts on a Sunday.
    expect(matchingDays(schedule('* * * * 1'), 2026, 11)).toEqual([2, 9, 16, 23, 30]);
    expect(matchingDays(schedule('* * * * 0'), 2026, 11)).toEqual([1, 8, 15, 22, 29]);
    expect(matchingDays(schedule('* * * * 6,0'), 2026, 11)).toEqual([
      1, 7, 8, 14, 15, 21, 22, 28, 29,
    ]);
  });

  it('runs on either day when both are set (a day that matches the day of month or the weekday)', () => {
    expect(matchingDays(schedule('* * 13 * 5'), 2026, 11)).toEqual([6, 13, 20, 27]);
    expect(matchingDays(schedule('* * 1-31 * 5'), 2026, 11)).toHaveLength(30);
  });

  it('needs both when one of the two day fields starts with a star', () => {
    // */2 is 1, 3, 5, ...; the Mondays of November 2026 are 2, 9, 16, 23, 30.
    expect(matchingDays(schedule('* * */2 * 1'), 2026, 11)).toEqual([9, 23]);
    expect(matchingDays(schedule('* * */2 * 1'), 2026, 6)).toEqual([1, 15, 29]);
    // The star may also be in the day of week: days up to the 15th that are Sunday, Tuesday, Thursday or Saturday.
    expect(matchingDays(schedule('* * 1-15 * */2'), 2026, 11)).toEqual([
      1, 3, 5, 7, 8, 10, 12, 14, 15,
    ]);
  });

  describe('Quartz days', () => {
    it('L is the last day of the month', () => {
      expect(matchingDays(schedule('0 0 0 L * ?'), 2026, 2)).toEqual([28]);
      expect(matchingDays(schedule('0 0 0 L * ?'), 2024, 2)).toEqual([29]);
      expect(matchingDays(schedule('0 0 0 L * ?'), 2026, 4)).toEqual([30]);
    });

    it('L-n is n days before the last day, and nothing when the month is too short', () => {
      expect(matchingDays(schedule('0 0 0 L-3 * ?'), 2026, 5)).toEqual([28]);
      expect(matchingDays(schedule('0 0 0 L-27 * ?'), 2026, 2)).toEqual([1]);
      expect(matchingDays(schedule('0 0 0 L-28 * ?'), 2026, 2)).toEqual([]);
    });

    it('LW is the last weekday of the month', () => {
      // 2026-10-31 is a Saturday, 2026-05-31 a Sunday, 2026-07-31 a Friday.
      expect(matchingDays(schedule('0 0 0 LW * ?'), 2026, 10)).toEqual([30]);
      expect(matchingDays(schedule('0 0 0 LW * ?'), 2026, 5)).toEqual([29]);
      expect(matchingDays(schedule('0 0 0 LW * ?'), 2026, 7)).toEqual([31]);
    });

    it('nW is the weekday nearest to day n, without leaving the month', () => {
      // 2026-11-15 Sunday -> Monday 16; 2026-08-15 Saturday -> Friday 14; 2026-11-18 Wednesday.
      expect(matchingDays(schedule('0 0 0 15W * ?'), 2026, 11)).toEqual([16]);
      expect(matchingDays(schedule('0 0 0 15W * ?'), 2026, 8)).toEqual([14]);
      expect(matchingDays(schedule('0 0 0 18W * ?'), 2026, 11)).toEqual([18]);
      // 2026-08-01 is a Saturday: the nearest weekday inside August is Monday the 3rd.
      expect(matchingDays(schedule('0 0 0 1W * ?'), 2026, 8)).toEqual([3]);
      // 2026-05-31 is a Sunday: the 29th, not June 1st.
      expect(matchingDays(schedule('0 0 0 31W * ?'), 2026, 5)).toEqual([29]);
      // 2026-02-28 is a Saturday and February has no 30th.
      expect(matchingDays(schedule('0 0 0 30W * ?'), 2026, 2)).toEqual([]);
    });

    it('nL is the last such weekday, n#k the k-th, and nothing for a fifth that is missing', () => {
      expect(matchingDays(schedule('0 0 0 ? * 5L'), 2026, 11)).toEqual([27]);
      expect(matchingDays(schedule('0 0 0 ? * 0L'), 2026, 11)).toEqual([29]);
      expect(matchingDays(schedule('0 0 0 ? * 1#1'), 2026, 11)).toEqual([2]);
      expect(matchingDays(schedule('0 0 0 ? * MON#5'), 2026, 11)).toEqual([30]);
      expect(matchingDays(schedule('0 0 0 ? * MON#5'), 2026, 12)).toEqual([]);
      expect(matchingDays(schedule('0 0 0 ? * 3#3'), 2026, 12)).toEqual([16]);
    });

    it('combines a special with the plain values of the same field', () => {
      expect(matchingDays(schedule('0 0 0 1,L * ?'), 2026, 11)).toEqual([1, 30]);
      expect(matchingDays(schedule('0 0 0 ? * 1,5L'), 2026, 11)).toEqual([2, 9, 16, 23, 27, 30]);
    });
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

describe('invariants of parseCron (seeded random text)', () => {
  const pieces = [
    '*',
    '?',
    '/',
    '-',
    ',',
    '#',
    'L',
    'W',
    '@',
    ' ',
    '0',
    '1',
    '5',
    '7',
    '12',
    '23',
    '31',
    '59',
    '60',
    '2026',
    'MON',
    'jan',
    'FRI',
    'L-3',
    '*/5',
    '1-5',
    '5L',
    '3#2',
    '15W',
    '\t',
    'é',
    '\u0000',
    '99999',
  ];

  const tokens = [
    '*',
    '*',
    '*',
    '*/5',
    '1',
    '0',
    '5',
    '12',
    '23',
    '1-5',
    '2,4',
    'MON',
    'jan',
    'L',
    '?',
    '5L',
    '3#2',
    '15W',
    '60',
    'x',
    '7',
    '0-7/2',
    '2026',
  ];

  it('never throws, and an accepted expression is well formed', () => {
    const random = generator(1_119);
    let accepted = 0;
    for (let round = 0; round < 3000; round += 1) {
      let text = '';
      if (round % 2 === 0) {
        const length = 1 + Math.floor(random() * 14);
        for (let at = 0; at < length; at += 1) {
          text += pieces[Math.floor(random() * pieces.length)] ?? '';
        }
      } else {
        // Five to seven fields, each one a likely token.
        const count = 5 + Math.floor(random() * 3);
        text = Array.from(
          { length: count },
          () => tokens[Math.floor(random() * tokens.length)] ?? '*',
        ).join(' ');
      }
      const result = parseCron(text);
      if (!result.ok) {
        expect(result.errors.length, JSON.stringify(text)).toBeGreaterThan(0);
        continue;
      }
      accepted += 1;
      const s = result.schedule;
      for (const field of [
        s.second,
        s.minute,
        s.hour,
        s.dayOfMonth,
        s.month,
        s.dayOfWeek,
        s.year,
      ]) {
        if (field === undefined) {
          continue;
        }
        const sorted = [...field.values].sort((a, b) => a - b);
        expect(field.values, JSON.stringify(text)).toEqual(sorted);
        expect(new Set(field.values).size, JSON.stringify(text)).toBe(field.values.length);
        for (const value of field.values) {
          const low = { month: 1, dayOfMonth: 1, year: YEAR_MIN }[field.name as string] ?? 0;
          const high =
            { month: 12, dayOfMonth: 31, year: YEAR_MAX, dayOfWeek: 6, hour: 23 }[
              field.name as string
            ] ?? 59;
          expect(value, JSON.stringify(text)).toBeGreaterThanOrEqual(low);
          expect(value, JSON.stringify(text)).toBeLessThanOrEqual(high);
        }
      }
      expect(parseCron(s.normalized).ok, s.normalized).toBe(true);
    }
    expect(accepted).toBeGreaterThan(20);
  });

  it('copes with hostile input', () => {
    for (const text of [
      '\u0000'.repeat(100),
      ','.repeat(400),
      '*/'.repeat(200),
      `${'1-'.repeat(200)}1 * * * *`,
      'x'.repeat(MAX_LENGTH),
      '* '.repeat(200),
      '\n\n\n',
      '@'.repeat(50),
    ]) {
      expect(() => parseCron(text)).not.toThrow();
    }
  });
});
