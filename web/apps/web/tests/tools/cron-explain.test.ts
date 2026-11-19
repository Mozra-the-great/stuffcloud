import { describe, expect, it } from 'vitest';
import { parseCron, type CronSchedule } from '../../src/tools/cron/cron.ts';
import { explainCron } from '../../src/tools/cron/explain.ts';

function schedule(text: string): CronSchedule {
  const result = parseCron(text);
  if (!result.ok) {
    throw new Error(`${text}: ${JSON.stringify(result.errors)}`);
  }
  return result.schedule;
}

/** Expression, English text, German text. */
const CORPUS: readonly (readonly [string, string, string])[] = [
  ['* * * * *', 'Every minute', 'Jede Minute'],
  ['*/5 * * * *', 'Every 5 minutes', 'Alle 5 Minuten'],
  ['0 9 * * 1-5', 'At 09:00, from Monday through Friday', 'Um 09:00 Uhr, von Montag bis Freitag'],
  ['30 17 * * 5', 'At 17:30, on Friday', 'Um 17:30 Uhr, am Freitag'],
  ['0 0 1 * *', 'At 00:00, on day 1 of the month', 'Um 00:00 Uhr, an Tag 1 des Monats'],
  [
    '0 0 1 1 *',
    'At 00:00, on day 1 of the month, in January',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Januar',
  ],
  ['0 0 * * 0', 'At 00:00, on Sunday', 'Um 00:00 Uhr, am Sonntag'],
  [
    '0 0 1,15 * *',
    'At 00:00, on days 1 and 15 of the month',
    'Um 00:00 Uhr, an den Tagen 1 und 15 des Monats',
  ],
  ['0 12 * 6-8 *', 'At 12:00, from June through August', 'Um 12:00 Uhr, von Juni bis August'],
  [
    '*/15 9-17 * * 1-5',
    'Every 15 minutes from 09:00 through 17:59, from Monday through Friday',
    'Alle 15 Minuten von 09:00 bis 17:59 Uhr, von Montag bis Freitag',
  ],
  ['0 0 * * 5-7', 'At 00:00, from Friday through Sunday', 'Um 00:00 Uhr, von Freitag bis Sonntag'],
  ['0 9,17 * * *', 'At 09:00 and 17:00 every day', 'Um 09:00 Uhr und 17:00 Uhr jeden Tag'],
  ['0 */2 * * *', 'At minute 0, every 2 hours', 'In Minute 0, alle 2 Stunden'],
  ['30 * * * *', 'At minute 30 of every hour', 'In Minute 30 jeder Stunde'],
  [
    '10-20 * * * *',
    'Every minute from minute 10 through 20 of every hour',
    'Jede Minute von Minute 10 bis 20 jeder Stunde',
  ],
  [
    '15,45 8-10 * * *',
    'At minutes 15 and 45, from hour 8 through 10',
    'In den Minuten 15 und 45, von Stunde 8 bis 10',
  ],
  [
    '0 8-17/2 * * 1,3,5',
    'At minute 0, every 2 hours from hour 8 through 17, on Monday, Wednesday and Friday',
    'In Minute 0, alle 2 Stunden von Stunde 8 bis 17, am Montag, Mittwoch und Freitag',
  ],
  [
    '5/15 8 * * *',
    'Every 15 minutes, starting at minute 5 from 08:00 through 08:59',
    'Alle 15 Minuten, ab Minute 5 von 08:00 bis 08:59 Uhr',
  ],
  [
    '0-30/10 * * * *',
    'Every 10 minutes from minute 0 through 30',
    'Alle 10 Minuten von Minute 0 bis 30',
  ],
  [
    '1,2,3,4,5,6,7,8,9 * * * *',
    'At minutes 1, 2, 3, 4, 5, 6, 7, 8 and 9 of every hour',
    'In den Minuten 1, 2, 3, 4, 5, 6, 7, 8 und 9 jeder Stunde',
  ],
  [
    '0 0,6,12,18 * * *',
    'At 00:00, 06:00, 12:00 and 18:00 every day',
    'Um 00:00 Uhr, 06:00 Uhr, 12:00 Uhr und 18:00 Uhr jeden Tag',
  ],
  [
    '0,15,30,45 9,10,11 * * *',
    'At minutes 0, 15, 30 and 45, at hours 9, 10 and 11',
    'In den Minuten 0, 15, 30 und 45, in den Stunden 9, 10 und 11',
  ],
  [
    '0 0 1 */3 *',
    'At 00:00, on day 1 of the month, in January, April, July and October',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Januar, April, Juli und Oktober',
  ],
  [
    '0 0 1 jan,apr,jul,oct *',
    'At 00:00, on day 1 of the month, in January, April, July and October',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Januar, April, Juli und Oktober',
  ],
  ['0 0 * * 1,3', 'At 00:00, on Monday and Wednesday', 'Um 00:00 Uhr, am Montag und Mittwoch'],
  [
    '0 0 * * 1,2,3,5',
    'At 00:00, from Monday through Wednesday and on Friday',
    'Um 00:00 Uhr, von Montag bis Mittwoch und am Freitag',
  ],
  [
    '0 0 * * 1-3,5',
    'At 00:00, from Monday through Wednesday and on Friday',
    'Um 00:00 Uhr, von Montag bis Mittwoch und am Freitag',
  ],
  ['0 0 * * 0,6', 'At 00:00, on Saturday and Sunday', 'Um 00:00 Uhr, am Samstag und Sonntag'],
  [
    '0 0 * * */2',
    'At 00:00, on Tuesday, Thursday, Saturday and Sunday',
    'Um 00:00 Uhr, am Dienstag, Donnerstag, Samstag und Sonntag',
  ],
  [
    '0 0 1-5 * *',
    'At 00:00, on days 1 through 5 of the month',
    'Um 00:00 Uhr, an den Tagen 1 bis 5 des Monats',
  ],
  [
    '0 0 */2 * *',
    'At 00:00, on every 2nd day of the month',
    'Um 00:00 Uhr, an jedem 2. Tag des Monats',
  ],
  [
    '0 0 10/5 * *',
    'At 00:00, on every 5th day of the month, starting on day 10',
    'Um 00:00 Uhr, an jedem 5. Tag des Monats, ab Tag 10',
  ],
  [
    '0 0 1-20/5 * *',
    'At 00:00, on every 5th day of the month from day 1 through 20',
    'Um 00:00 Uhr, an jedem 5. Tag des Monats von Tag 1 bis 20',
  ],
  [
    '0 0 1,10-15 * *',
    'At 00:00, on day 1 of the month and on days 10 through 15 of the month',
    'Um 00:00 Uhr, an Tag 1 des Monats und an den Tagen 10 bis 15 des Monats',
  ],
  [
    '0 0 13 * 5',
    'At 00:00, on day 13 of the month or on Friday',
    'Um 00:00 Uhr, an Tag 13 des Monats oder am Freitag',
  ],
  [
    '0 0 */2 * 1',
    'At 00:00, on every 2nd day of the month, only on Monday',
    'Um 00:00 Uhr, an jedem 2. Tag des Monats, nur am Montag',
  ],
  ['0 0 1-31 * 1', 'At 00:00 every day', 'Um 00:00 Uhr jeden Tag'],
  [
    '0 0 1 3-5 *',
    'At 00:00, on day 1 of the month, from March through May',
    'Um 00:00 Uhr, an Tag 1 des Monats, von März bis Mai',
  ],
  [
    '0 0 1 1,3-5,12 *',
    'At 00:00, on day 1 of the month, in January, from March through May and in December',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Januar, von März bis Mai und im Dezember',
  ],
  [
    '0 0 1 2 *',
    'At 00:00, on day 1 of the month, in February',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Februar',
  ],
  ['0 0 5 * 1-7', 'At 00:00 every day', 'Um 00:00 Uhr jeden Tag'],
  ['*/10 * * * * *', 'Every 10 seconds', 'Alle 10 Sekunden'],
  ['30 * * * * *', 'At second 30 of every minute', 'In Sekunde 30 jeder Minute'],
  [
    '0,30 * * * * *',
    'At seconds 0 and 30 of every minute',
    'In den Sekunden 0 und 30 jeder Minute',
  ],
  ['* * * * * *', 'Every second', 'Jede Sekunde'],
  [
    '*/10 * 9 * * *',
    'Every 10 seconds from 09:00 through 09:59',
    'Alle 10 Sekunden von 09:00 bis 09:59 Uhr',
  ],
  [
    '10 5 * * * *',
    'At second 10, at minute 5 of every hour',
    'In Sekunde 10, in Minute 5 jeder Stunde',
  ],
  ['0 0 0 * * *', 'At 00:00 every day', 'Um 00:00 Uhr jeden Tag'],
  ['15 30 9 * * *', 'At 09:30:15 every day', 'Um 09:30:15 Uhr jeden Tag'],
  ['0 0 12 * * ? 2026-2030', 'At 12:00, from 2026 through 2030', 'Um 12:00 Uhr, von 2026 bis 2030'],
  [
    '0 0 12 1 1 ? 2030',
    'At 12:00, on day 1 of the month, in January, in 2030',
    'Um 12:00 Uhr, an Tag 1 des Monats, im Januar, im Jahr 2030',
  ],
  [
    '0 0 12 1 1 ? 2030,2032',
    'At 12:00, on day 1 of the month, in January, in 2030 and 2032',
    'Um 12:00 Uhr, an Tag 1 des Monats, im Januar, in den Jahren 2030 und 2032',
  ],
  [
    '0 0 12 1 1 ? 2026/2',
    'At 12:00, on day 1 of the month, in January, every 2 years, starting in 2026',
    'Um 12:00 Uhr, an Tag 1 des Monats, im Januar, alle 2 Jahre, ab 2026',
  ],
  [
    '0 0 12 1 1 ? 2026-2040/4',
    'At 12:00, on day 1 of the month, in January, every 4 years from 2026 through 2040',
    'Um 12:00 Uhr, an Tag 1 des Monats, im Januar, alle 4 Jahre von 2026 bis 2040',
  ],
  [
    '0 0 12 1 1 ? 2026,2030-2032',
    'At 12:00, on day 1 of the month, in January, in 2026 and from 2030 through 2032',
    'Um 12:00 Uhr, an Tag 1 des Monats, im Januar, im Jahr 2026 und von 2030 bis 2032',
  ],
  [
    '0 0 0 L * ?',
    'At 00:00, on the last day of the month',
    'Um 00:00 Uhr, am letzten Tag des Monats',
  ],
  [
    '0 0 0 L-1 * ?',
    'At 00:00, 1 day before the last day of the month',
    'Um 00:00 Uhr, 1 Tag vor dem letzten Tag des Monats',
  ],
  [
    '0 0 0 L-3 * ?',
    'At 00:00, 3 days before the last day of the month',
    'Um 00:00 Uhr, 3 Tage vor dem letzten Tag des Monats',
  ],
  [
    '0 0 0 LW * ?',
    'At 00:00, on the last weekday of the month',
    'Um 00:00 Uhr, am letzten Werktag des Monats',
  ],
  [
    '0 0 0 15W * ?',
    'At 00:00, on the weekday nearest to day 15 of the month',
    'Um 00:00 Uhr, am Werktag, der dem 15. des Monats am nächsten liegt',
  ],
  [
    '0 0 0 ? * 5L',
    'At 00:00, on the last Friday of the month',
    'Um 00:00 Uhr, am letzten Freitag des Monats',
  ],
  [
    '0 0 0 ? * FRI#3',
    'At 00:00, on the third Friday of the month',
    'Um 00:00 Uhr, am dritten Freitag des Monats',
  ],
  [
    '0 0 0 ? * MON#1',
    'At 00:00, on the first Monday of the month',
    'Um 00:00 Uhr, am ersten Montag des Monats',
  ],
  [
    '0 0 0 ? * SUN#5',
    'At 00:00, on the fifth Sunday of the month',
    'Um 00:00 Uhr, am fünften Sonntag des Monats',
  ],
  [
    '0 0 0 ? * 2#2,4#4',
    'At 00:00, on the second Tuesday of the month and on the fourth Thursday of the month',
    'Um 00:00 Uhr, am zweiten Dienstag des Monats und am vierten Donnerstag des Monats',
  ],
  [
    '0 0 0 L * 1',
    'At 00:00, on the last day of the month or on Monday',
    'Um 00:00 Uhr, am letzten Tag des Monats oder am Montag',
  ],
  [
    '0 0 0 ? * MON-FRI',
    'At 00:00, from Monday through Friday',
    'Um 00:00 Uhr, von Montag bis Freitag',
  ],
  [
    '0 0 9 ? * MON-FRI',
    'At 09:00, from Monday through Friday',
    'Um 09:00 Uhr, von Montag bis Freitag',
  ],
  ['0 * * * *', 'At minute 0 of every hour', 'In Minute 0 jeder Stunde'],
  ['* * * * 1', 'Every minute, on Monday', 'Jede Minute, am Montag'],
  ['*/7 */3 * * *', 'Every 7 minutes, every 3 hours', 'Alle 7 Minuten, alle 3 Stunden'],
  [
    '1-5 * * * *',
    'Every minute from minute 1 through 5 of every hour',
    'Jede Minute von Minute 1 bis 5 jeder Stunde',
  ],
  ['5 1-5 * * *', 'At minute 5, from hour 1 through 5', 'In Minute 5, von Stunde 1 bis 5'],
  ['0 22 * * 1-5', 'At 22:00, from Monday through Friday', 'Um 22:00 Uhr, von Montag bis Freitag'],
  ['0 5 1 * *', 'At 05:00, on day 1 of the month', 'Um 05:00 Uhr, an Tag 1 des Monats'],
  [
    '59 23 31 12 *',
    'At 23:59, on day 31 of the month, in December',
    'Um 23:59 Uhr, an Tag 31 des Monats, im Dezember',
  ],
  [
    '0 12 29 2 *',
    'At 12:00, on day 29 of the month, in February',
    'Um 12:00 Uhr, an Tag 29 des Monats, im Februar',
  ],
  [
    '*/30 9-17 * * *',
    'Every 30 minutes from 09:00 through 17:59',
    'Alle 30 Minuten von 09:00 bis 17:59 Uhr',
  ],
  ['0 9-17 * * *', 'At minute 0, from hour 9 through 17', 'In Minute 0, von Stunde 9 bis 17'],
  ['30 9-17 * * *', 'At minute 30, from hour 9 through 17', 'In Minute 30, von Stunde 9 bis 17'],
  [
    '*/20 6 * * *',
    'Every 20 minutes from 06:00 through 06:59',
    'Alle 20 Minuten von 06:00 bis 06:59 Uhr',
  ],
  ['5,10 6 * * *', 'At 06:05 and 06:10 every day', 'Um 06:05 Uhr und 06:10 Uhr jeden Tag'],
  [
    '*/5 0-5 * * *',
    'Every 5 minutes from 00:00 through 05:59',
    'Alle 5 Minuten von 00:00 bis 05:59 Uhr',
  ],
  ['* 5 * * *', 'Every minute from 05:00 through 05:59', 'Jede Minute von 05:00 bis 05:59 Uhr'],
  ['@hourly', 'At minute 0 of every hour', 'In Minute 0 jeder Stunde'],
  ['@daily', 'At 00:00 every day', 'Um 00:00 Uhr jeden Tag'],
  ['@weekly', 'At 00:00, on Sunday', 'Um 00:00 Uhr, am Sonntag'],
  ['@monthly', 'At 00:00, on day 1 of the month', 'Um 00:00 Uhr, an Tag 1 des Monats'],
  [
    '@yearly',
    'At 00:00, on day 1 of the month, in January',
    'Um 00:00 Uhr, an Tag 1 des Monats, im Januar',
  ],
  ['0 0 21 * *', 'At 00:00, on day 21 of the month', 'Um 00:00 Uhr, an Tag 21 des Monats'],
  ['0 0 22 * *', 'At 00:00, on day 22 of the month', 'Um 00:00 Uhr, an Tag 22 des Monats'],
  ['0 0 23 * *', 'At 00:00, on day 23 of the month', 'Um 00:00 Uhr, an Tag 23 des Monats'],
  [
    '0 0 11,12,13 * *',
    'At 00:00, on days 11, 12 and 13 of the month',
    'Um 00:00 Uhr, an den Tagen 11, 12 und 13 des Monats',
  ],
  [
    '0 0 */11 * *',
    'At 00:00, on every 11th day of the month',
    'Um 00:00 Uhr, an jedem 11. Tag des Monats',
  ],
  [
    '0 0 */13 * *',
    'At 00:00, on every 13th day of the month',
    'Um 00:00 Uhr, an jedem 13. Tag des Monats',
  ],
  [
    '0 0 1/22 * *',
    'At 00:00, on every 22nd day of the month, starting on day 1',
    'Um 00:00 Uhr, an jedem 22. Tag des Monats, ab Tag 1',
  ],
  ['*/2 * * * * *', 'Every 2 seconds', 'Alle 2 Sekunden'],
  ['0 */3 * * * *', 'Every 3 minutes', 'Alle 3 Minuten'],
  ['0 0 */2 * * *', 'At minute 0, every 2 hours', 'In Minute 0, alle 2 Stunden'],
  [
    '1-5 * * * * *',
    'Every second from second 1 through 5 of every minute',
    'Jede Sekunde von Sekunde 1 bis 5 jeder Minute',
  ],
  [
    '*/10 5 * * * *',
    'Every 10 seconds, at minute 5 of every hour',
    'Alle 10 Sekunden, in Minute 5 jeder Stunde',
  ],
  ['5 */10 * * * *', 'At second 5, every 10 minutes', 'In Sekunde 5, alle 10 Minuten'],
  [
    '0 0 */3 * *',
    'At 00:00, on every 3rd day of the month',
    'Um 00:00 Uhr, an jedem 3. Tag des Monats',
  ],
  [
    '0 0 */4 * *',
    'At 00:00, on every 4th day of the month',
    'Um 00:00 Uhr, an jedem 4. Tag des Monats',
  ],
  [
    '0 0 */12 * *',
    'At 00:00, on every 12th day of the month',
    'Um 00:00 Uhr, an jedem 12. Tag des Monats',
  ],
  [
    '0 0 */21 * *',
    'At 00:00, on every 21st day of the month',
    'Um 00:00 Uhr, an jedem 21. Tag des Monats',
  ],
  [
    '0 0 */23 * *',
    'At 00:00, on every 23rd day of the month',
    'Um 00:00 Uhr, an jedem 23. Tag des Monats',
  ],
];

describe('explainCron', () => {
  it.each(CORPUS)('%s', (text, en, de) => {
    expect(explainCron(schedule(text), 'en')).toBe(en);
    expect(explainCron(schedule(text), 'de')).toBe(de);
  });

  it('describes an expression the same way whatever the field separators are', () => {
    expect(explainCron(schedule('  0	9   *  * 1-5 '), 'en')).toBe(
      'At 09:00, from Monday through Friday',
    );
  });

  it('writes the names of days and months in the language asked for', () => {
    expect(explainCron(schedule('0 0 * 3 1'), 'de')).toContain('März');
    expect(explainCron(schedule('0 0 * 3 1'), 'en')).toContain('March');
    expect(explainCron(schedule('0 0 * 3 1'), 'de')).toContain('Montag');
  });

  it('says "every day" only for a time of day that nothing else limits', () => {
    expect(explainCron(schedule('0 9 * * *'), 'en')).toBe('At 09:00 every day');
    expect(explainCron(schedule('0 9 * * *'), 'de')).toBe('Um 09:00 Uhr jeden Tag');
    expect(explainCron(schedule('0 9 * 5 *'), 'en')).toBe('At 09:00, in May');
    expect(explainCron(schedule('*/5 * * * *'), 'en')).toBe('Every 5 minutes');
  });

  it('describes more than eight exact times field by field', () => {
    expect(explainCron(schedule('0,10,20,30,40 8,9 * * *'), 'en')).toBe(
      'At minutes 0, 10, 20, 30 and 40, at hours 8 and 9',
    );
    expect(explainCron(schedule('0 0,2,4,6,8,10,12,14 * * *'), 'en')).toBe(
      'At 00:00, 02:00, 04:00, 06:00, 08:00, 10:00, 12:00 and 14:00 every day',
    );
    expect(explainCron(schedule('0 0,2,4,6,8,10,12,14,16 * * *'), 'en')).toBe(
      'At minute 0, at hours 0, 2, 4, 6, 8, 10, 12, 14 and 16',
    );
  });

  it('shows the seconds of an exact time, and several of them', () => {
    expect(explainCron(schedule('15,45 30 9 * * *'), 'en')).toBe(
      'At 09:30:15 and 09:30:45 every day',
    );
  });

  it('treats a step that selects one value as that value', () => {
    expect(explainCron(schedule('59/30 * * * *'), 'en')).toBe('At minute 59 of every hour');
  });

  it('mixes a stepped second with fixed minute and hour', () => {
    expect(explainCron(schedule('*/10 5 9 * * *'), 'en')).toBe(
      'Every 10 seconds, at minute 5, at hour 9',
    );
  });

  it('leaves a free year out', () => {
    expect(explainCron(schedule('0 0 0 1 1 ? *'), 'en')).toBe(
      'At 00:00, on day 1 of the month, in January',
    );
  });
});
