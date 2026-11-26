import {
  browserTimeZone,
  instantsOf,
  isTimeZone,
  offsetAt,
  offsetsAround,
  wallTimeAt,
} from '../cron/time-zone.ts';

export { browserTimeZone, isTimeZone };

/**
 * Epoch numbers, ISO 8601 dates and time zones. Zones come from `Intl` (see `cron/time-zone.ts`), so no
 * time zone database is shipped.
 */

export type EpochUnit = 'auto' | 'seconds' | 'milliseconds';

/** The most a JavaScript date can hold, in milliseconds either side of 1970. */
export const MAX_MILLISECONDS = 8.64e15;
export const MAX_INPUT_LENGTH = 100;

export type ParseErrorCode =
  'empty' | 'too-long' | 'format' | 'range' | 'date' | 'time' | 'offset' | 'gap';

export type InputKind = 'seconds' | 'milliseconds' | 'iso';

export type ParseResult =
  | {
      readonly ok: true;
      /** The instant, in milliseconds since the epoch. */
      readonly ms: number;
      readonly kind: InputKind;
      /** The clock time the zone shows twice (the clock went back): the earlier instant was taken. */
      readonly ambiguous: boolean;
    }
  | { readonly ok: false; readonly error: ParseErrorCode };

const NUMBER = /^[+-]?\d{1,20}(?:\.\d{1,12})?$/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)? ?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysIn(year: number, month: number): number {
  if (month === 2) {
    return isLeap(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `Date.UTC` reads years 0 to 99 as 1900 to 1999; this does not. */
function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

/** The earliest and latest instants whose civil date has a year from 1 to 9999: where a zone clock is shown. */
const ZONE_MIN = utc(1, 1, 1);
const ZONE_MAX = utc(9999, 12, 31, 23, 59, 59, 999);

function parseEpoch(text: string, unit: EpochUnit): ParseResult {
  const value = Number(text);
  let kind: 'seconds' | 'milliseconds';
  if (unit === 'auto') {
    // Seconds reach 10^11 only in the year 5138; milliseconds were at 10^11 in 1973.
    kind = Math.abs(value) >= 1e11 ? 'milliseconds' : 'seconds';
  } else {
    kind = unit;
  }
  const ms = Math.round(kind === 'seconds' ? value * 1000 : value);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MILLISECONDS) {
    return { ok: false, error: 'range' };
  }
  return { ok: true, ms: ms === 0 ? 0 : ms, kind, ambiguous: false };
}

function parseIso(text: string, timeZone: string): ParseResult {
  const found = ISO.exec(text);
  if (found === null) {
    return { ok: false, error: 'format' };
  }
  const [, y, mo, d, h, mi, s, fraction, zone] = found;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) {
    return { ok: false, error: 'date' };
  }
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, error: 'time' };
  }
  const ms = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0').slice(0, 3));
  const wall = utc(year, month, day, hour, minute, second, ms);
  if (zone !== undefined) {
    // "Z" has no digits: it reads as +00:00 (`Number('')` is 0).
    const sign = zone.startsWith('-') ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(3).replace(':', ''));
    if (offsetHours > 23 || offsetMinutes > 59) {
      return { ok: false, error: 'offset' };
    }
    const offset = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
    return { ok: true, ms: wall - offset, kind: 'iso', ambiguous: false };
  }
  // UTC needs no table of offsets, and the table counts the years before year 1 by era (0001-01-01 would read as ambiguous).
  if (timeZone === 'UTC') {
    return { ok: true, ms: wall, kind: 'iso', ambiguous: false };
  }
  // No offset in the text: the clock time is read in the chosen zone.
  const [first, later] = instantsOf(wall, offsetsAround(utc(year, month, day), timeZone));
  if (first === undefined) {
    return { ok: false, error: 'gap' };
  }
  return { ok: true, ms: first, kind: 'iso', ambiguous: later !== undefined };
}

/**
 * Reads an epoch number (seconds or milliseconds, a fraction allowed) or an ISO 8601 date with or without a
 * time. A time without an offset is read as a clock time in `timeZone`.
 */
export function parseInstant(input: string, unit: EpochUnit, timeZone: string): ParseResult {
  if (input.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  const text = input.trim();
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  if (NUMBER.test(text)) {
    return parseEpoch(text, unit);
  }
  return parseIso(text, timeZone);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function offsetText(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  // Old clock times (before 1900) had offsets with seconds; the text shows whole minutes.
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  return `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export interface Formats {
  readonly seconds: string;
  readonly milliseconds: string;
  /** ISO 8601 in UTC. */
  readonly isoUtc: string;
  /** HTTP date (RFC 9110), in GMT. */
  readonly http: string;
  /** ISO 8601 with the offset of the zone; `undefined` outside the years 1 to 9999. */
  readonly isoZone: string | undefined;
  /** The date and time in words in the zone; `undefined` outside the years 1 to 9999. */
  readonly local: string | undefined;
}

/** Every format of an instant. */
export function formatInstant(ms: number, timeZone: string, locale: string): Formats {
  const date = new Date(ms);
  let isoZone: string | undefined;
  let local: string | undefined;
  if (ms >= ZONE_MIN && ms <= ZONE_MAX) {
    const wall = wallTimeAt(ms, timeZone);
    const fraction = ((ms % 1000) + 1000) % 1000;
    isoZone =
      `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
      `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}` +
      `${fraction === 0 ? '' : `.${pad(fraction, 3)}`}${offsetText(offsetAt(ms, timeZone))}`;
    local = new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone,
    }).format(date);
  }
  return {
    seconds: ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(3),
    milliseconds: String(ms),
    isoUtc: date.toISOString(),
    http: date.toUTCString(),
    isoZone,
    local,
  };
}
