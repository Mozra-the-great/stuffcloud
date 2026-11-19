/**
 * Time zones through `Intl` only (no tz database in the bundle): the wall-clock time of an instant in
 * a zone, and the instants at which a wall-clock time happens.
 */

/** Zones offered when the browser cannot list them (`Intl.supportedValuesOf`). */
const FALLBACK_ZONES: readonly string[] = [
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Kolkata',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Pacific/Auckland',
  'Pacific/Honolulu',
];

/** Current names of zones that browsers still list under their old name. */
const MODERN_NAMES: readonly string[] = [
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Yangon',
  'Asia/Ho_Chi_Minh',
  'Europe/Kyiv',
  'America/Nuuk',
  'Atlantic/Faroe',
  'Pacific/Kanton',
];

/** A date and time as a clock on the wall shows it. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `name` is a time zone this browser knows. */
export function isTimeZone(name: string): boolean {
  if (name === '') {
    return false;
  }
  try {
    formatterFor(name);
    return true;
  } catch {
    return false;
  }
}

/** The IANA names this browser knows, with `UTC` first. */
export function listTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] })
    .supportedValuesOf;
  let names: readonly string[];
  try {
    names = supported === undefined ? FALLBACK_ZONES : supported('timeZone');
  } catch {
    names = FALLBACK_ZONES;
  }
  const zones = new Set(names.filter((name) => name !== 'UTC' && isTimeZone(name)));
  // Browsers list the old spelling of some names (Asia/Calcutta); people look for the new one.
  for (const name of MODERN_NAMES) {
    if (isTimeZone(name)) {
      zones.add(name);
    }
  }
  return ['UTC', ...[...zones].sort()];
}

/** The zone of this browser, or `UTC` when it does not say. */
export function browserTimeZone(): string {
  try {
    const name = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(name) ? name : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The wall-clock time of an instant (milliseconds since the epoch) in a zone. */
export function wallTimeAt(instant: number, timeZone: string): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') {
      fields[part.type] = Number(part.value);
    }
  }
  return {
    year: fields['year'] ?? 1970,
    month: fields['month'] ?? 1,
    day: fields['day'] ?? 1,
    hour: (fields['hour'] ?? 0) % 24,
    minute: fields['minute'] ?? 0,
    second: fields['second'] ?? 0,
  };
}

/** A wall-clock time read as if it were UTC: the clock-on-the-wall number line. */
export function wallToNumber(wall: WallTime): number {
  // `Date.UTC` reads the years 0 to 99 as 1900 to 1999, so the year is set separately.
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return date.getTime();
}

/** The offset of a zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallToNumber(wallTimeAt(whole, timeZone)) - whole;
}

/**
 * How the clock of a zone relates to UTC around one day: either one offset for all of it, or a switch
 * (summer time) at `at` from `before` to `after`.
 */
export interface DayOffsets {
  readonly before: number;
  readonly after: number;
  /** The instant of the switch; irrelevant when `before === after`. */
  readonly at: number;
}

/**
 * The offsets around a civil day (`dayStart`: its midnight on the wall-clock number line). A switch
 * is searched for within one day before and two days after, which holds one transition of any zone.
 */
export function offsetsAround(dayStart: number, timeZone: string): DayOffsets {
  const low = dayStart - 86_400_000;
  const high = dayStart + 2 * 86_400_000;
  const before = offsetAt(low, timeZone);
  const after = offsetAt(high, timeZone);
  if (before === after) {
    return { before, after, at: 0 };
  }
  // Bisect for the first second with the new offset.
  let lo = low;
  let hi = high;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetAt(mid, timeZone) === before) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { before, after, at: hi };
}

/**
 * The instants at which a wall-clock time (on the wall-clock number line) happens, ascending: none when
 * the clock skips it, two when the clock goes back over it, else one.
 */
export function instantsOf(wall: number, offsets: DayOffsets): number[] {
  const early = wall - offsets.before;
  if (offsets.before === offsets.after) {
    return [early];
  }
  const instants: number[] = [];
  if (early < offsets.at) {
    instants.push(early);
  }
  const late = wall - offsets.after;
  if (late >= offsets.at) {
    instants.push(late);
  }
  return instants.sort((a, b) => a - b);
}
