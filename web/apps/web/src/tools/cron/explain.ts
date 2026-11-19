import type { Locale } from '../../i18n/locales.ts';
import type { CronField, CronItem, CronSchedule } from './cron.ts';

/**
 * Plain-language description of a CRON schedule, in German and English (T-19, issue #24).
 *
 * The sentence is built from the fields: the time of day, the days, the months and the years, joined
 * by commas ("At 09:00, from Monday through Friday"). Every field is described as what it selects,
 * never by its position, so the text is right for each of the three dialects.
 */

type Unit = 'second' | 'minute' | 'hour';

type Piece =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | {
      readonly kind: 'step';
      readonly from: number;
      readonly to: number;
      readonly step: number;
      readonly base: 'any' | 'start' | 'range';
    };

/** What a numeric field selects. */
type Sel =
  | { readonly kind: 'any' }
  | { readonly kind: 'values'; readonly values: readonly number[] }
  | { readonly kind: 'pieces'; readonly pieces: readonly Piece[] };

/** The words of one language. Every function returns a fragment in lower case (except names). */
interface Words {
  list(items: readonly string[]): string;
  /** "Every minute". */
  every(unit: Unit): string;
  /** "every 5 minutes". */
  everyN(unit: Unit, step: number): string;
  /** "at minute 5", "at minutes 5 and 10". */
  at(unit: Unit, values: readonly number[]): string;
  /** "from minute 10 through 20". */
  between(unit: Unit, from: number, to: number): string;
  /** "every minute from minute 10 through 20". */
  everyBetween(unit: Unit, from: number, to: number): string;
  /** "every 5 minutes, starting at minute 10". */
  stepStart(unit: Unit, step: number, from: number): string;
  /** "every 5 minutes from minute 10 through 20". */
  stepRange(unit: Unit, step: number, from: number, to: number): string;
  /** The clause plus "of every hour": it repeats in each of the coarser unit. */
  ofEvery(clause: string, parent: 'minute' | 'hour'): string;
  /** "At 09:30 and 17:30". */
  exactTimes(times: readonly string[]): string;
  /** "Every minute from 09:00 through 17:59". */
  window(clause: string, from: string, to: string): string;
  /** Prefix of a set of weekdays or months, and the phrase for a run of them. */
  weekdays: { readonly prefix: string; run(a: string, b: string): string };
  months: { readonly prefix: string; run(a: string, b: string): string };
  dayValues(values: readonly number[]): string;
  dayRange(from: number, to: number): string;
  dayStep(step: number, base: 'any' | 'start' | 'range', from: number, to: number): string;
  lastDay: string;
  lastWeekday: string;
  daysBeforeLast(offset: number): string;
  nearestWeekday(day: number): string;
  lastWeekdayNamed(name: string): string;
  nthWeekdayNamed(nth: number, name: string): string;
  or(a: string, b: string): string;
  and(a: string, b: string): string;
  yearValues(values: readonly number[]): string;
  yearRange(from: number, to: number): string;
  yearStep(step: number, base: 'any' | 'start' | 'range', from: number, to: number): string;
  /** "every day" for a time of day without any restriction of the days. */
  everyDay: string;
}

function ordinalEn(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) {
    return `${n}th`;
  }
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const NTH_EN = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
const NTH_DE = ['ersten', 'zweiten', 'dritten', 'vierten', 'fünften'] as const;

const UNIT_EN: Readonly<Record<Unit, readonly [string, string]>> = {
  second: ['second', 'seconds'],
  minute: ['minute', 'minutes'],
  hour: ['hour', 'hours'],
};

const UNIT_DE: Readonly<Record<Unit, readonly [string, string, string]>> = {
  second: ['Sekunde', 'Sekunden', 'Sekunde'],
  minute: ['Minute', 'Minuten', 'Minute'],
  hour: ['Stunde', 'Stunden', 'Stunde'],
};

function listFormat(locale: string, items: readonly string[]): string {
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' }).format(items);
}

function join(items: readonly number[], words: Words): string {
  return words.list(items.map(String));
}

const EN: Words = {
  list: (items) => listFormat('en-GB', items),
  every: (unit) => `every ${UNIT_EN[unit][0]}`,
  everyN: (unit, step) => `every ${step} ${UNIT_EN[unit][1]}`,
  at: (unit, values) => `at ${UNIT_EN[unit][values.length === 1 ? 0 : 1]} ${join(values, EN)}`,
  between: (unit, from, to) => `from ${UNIT_EN[unit][0]} ${from} through ${to}`,
  everyBetween: (unit, from, to) =>
    `every ${UNIT_EN[unit][0]} from ${UNIT_EN[unit][0]} ${from} through ${to}`,
  stepStart: (unit, step, from) =>
    `every ${step} ${UNIT_EN[unit][1]}, starting at ${UNIT_EN[unit][0]} ${from}`,
  stepRange: (unit, step, from, to) =>
    `every ${step} ${UNIT_EN[unit][1]} from ${UNIT_EN[unit][0]} ${from} through ${to}`,
  ofEvery: (clause, parent) => `${clause} of every ${parent}`,
  exactTimes: (times) => `at ${listFormat('en-GB', times)}`,
  window: (clause, from, to) => `${clause} from ${from} through ${to}`,
  weekdays: { prefix: 'on ', run: (a, b) => `from ${a} through ${b}` },
  months: { prefix: 'in ', run: (a, b) => `from ${a} through ${b}` },
  dayValues: (values) =>
    `on ${values.length === 1 ? 'day' : 'days'} ${join(values, EN)} of the month`,
  dayRange: (from, to) => `on days ${from} through ${to} of the month`,
  dayStep: (step, base, from, to) => {
    const every = `on every ${ordinalEn(step)} day of the month`;
    if (base === 'start') {
      return `${every}, starting on day ${from}`;
    }
    return base === 'range' ? `${every} from day ${from} through ${to}` : every;
  },
  lastDay: 'on the last day of the month',
  lastWeekday: 'on the last weekday of the month',
  daysBeforeLast: (offset) =>
    `${offset} ${offset === 1 ? 'day' : 'days'} before the last day of the month`,
  nearestWeekday: (day) => `on the weekday nearest to day ${day} of the month`,
  lastWeekdayNamed: (name) => `on the last ${name} of the month`,
  nthWeekdayNamed: (nth, name) => `on the ${NTH_EN[nth - 1] ?? String(nth)} ${name} of the month`,
  or: (a, b) => `${a} or ${b}`,
  and: (a, b) => `${a}, only ${b}`,
  yearValues: (values) => `in ${join(values, EN)}`,
  yearRange: (from, to) => `from ${from} through ${to}`,
  yearStep: (step, base, from, to) => {
    const every = `every ${step} years`;
    if (base === 'start') {
      return `${every}, starting in ${from}`;
    }
    return base === 'range' ? `${every} from ${from} through ${to}` : every;
  },
  everyDay: 'every day',
};

const DE: Words = {
  list: (items) => listFormat('de', items),
  every: (unit) => `jede ${UNIT_DE[unit][0]}`,
  everyN: (unit, step) => `alle ${step} ${UNIT_DE[unit][1]}`,
  at: (unit, values) =>
    values.length === 1
      ? `in ${UNIT_DE[unit][0]} ${join(values, DE)}`
      : `in den ${UNIT_DE[unit][1]} ${join(values, DE)}`,
  between: (unit, from, to) => `von ${UNIT_DE[unit][0]} ${from} bis ${to}`,
  everyBetween: (unit, from, to) =>
    `jede ${UNIT_DE[unit][0]} von ${UNIT_DE[unit][0]} ${from} bis ${to}`,
  stepStart: (unit, step, from) =>
    `alle ${step} ${UNIT_DE[unit][1]}, ab ${UNIT_DE[unit][0]} ${from}`,
  stepRange: (unit, step, from, to) =>
    `alle ${step} ${UNIT_DE[unit][1]} von ${UNIT_DE[unit][0]} ${from} bis ${to}`,
  ofEvery: (clause, parent) => `${clause} jeder ${UNIT_DE[parent][2]}`,
  exactTimes: (times) =>
    `um ${listFormat(
      'de',
      times.map((time) => `${time} Uhr`),
    )}`,
  window: (clause, from, to) => `${clause} von ${from} bis ${to} Uhr`,
  weekdays: { prefix: 'am ', run: (a, b) => `von ${a} bis ${b}` },
  months: { prefix: 'im ', run: (a, b) => `von ${a} bis ${b}` },
  dayValues: (values) =>
    `${values.length === 1 ? 'an Tag' : 'an den Tagen'} ${join(values, DE)} des Monats`,
  dayRange: (from, to) => `an den Tagen ${from} bis ${to} des Monats`,
  dayStep: (step, base, from, to) => {
    const every = `an jedem ${step}. Tag des Monats`;
    if (base === 'start') {
      return `${every}, ab Tag ${from}`;
    }
    return base === 'range' ? `${every} von Tag ${from} bis ${to}` : every;
  },
  lastDay: 'am letzten Tag des Monats',
  lastWeekday: 'am letzten Werktag des Monats',
  daysBeforeLast: (offset) =>
    `${offset} ${offset === 1 ? 'Tag' : 'Tage'} vor dem letzten Tag des Monats`,
  nearestWeekday: (day) => `am Werktag, der dem ${day}. des Monats am nächsten liegt`,
  lastWeekdayNamed: (name) => `am letzten ${name} des Monats`,
  nthWeekdayNamed: (nth, name) => `am ${NTH_DE[nth - 1] ?? String(nth)} ${name} des Monats`,
  or: (a, b) => `${a} oder ${b}`,
  and: (a, b) => `${a}, nur ${b}`,
  yearValues: (values) =>
    values.length === 1 ? `im Jahr ${join(values, DE)}` : `in den Jahren ${join(values, DE)}`,
  yearRange: (from, to) => `von ${from} bis ${to}`,
  yearStep: (step, base, from, to) => {
    const every = `alle ${step} Jahre`;
    if (base === 'start') {
      return `${every}, ab ${from}`;
    }
    return base === 'range' ? `${every} von ${from} bis ${to}` : every;
  },
  everyDay: 'jeden Tag',
};

const WORDS: Readonly<Record<Locale, Words>> = { en: EN, de: DE };

function upperFirst(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function isPlain(item: CronItem): item is CronItem & Piece {
  return item.kind === 'value' || item.kind === 'range' || item.kind === 'step';
}

/** What a numeric field selects, in the simplest terms. */
function selectionOf(field: CronField): Sel {
  if (field.wildcard) {
    return { kind: 'any' };
  }
  const pieces: Piece[] = [];
  for (const item of field.items) {
    if (!isPlain(item)) {
      continue;
    }
    if (item.kind === 'step' && item.from + item.step > item.to) {
      pieces.push({ kind: 'value', value: item.from });
    } else {
      pieces.push(item);
    }
  }
  if (pieces.every((piece) => piece.kind === 'value')) {
    return { kind: 'values', values: field.values };
  }
  return { kind: 'pieces', pieces: [...pieces].sort(comparePieces) };
}

function startOf(piece: Piece): number {
  return piece.kind === 'value' ? piece.value : piece.from;
}

function comparePieces(a: Piece, b: Piece): number {
  return startOf(a) - startOf(b);
}

function clause(words: Words, unit: Unit, selection: Sel): string {
  if (selection.kind === 'any') {
    return words.every(unit);
  }
  if (selection.kind === 'values') {
    return words.at(unit, selection.values);
  }
  const values = selection.pieces.flatMap((piece) => (piece.kind === 'value' ? [piece.value] : []));
  const parts: string[] = values.length > 0 ? [words.at(unit, values)] : [];
  for (const piece of selection.pieces) {
    if (piece.kind === 'range') {
      parts.push(
        unit === 'hour'
          ? words.between(unit, piece.from, piece.to)
          : words.everyBetween(unit, piece.from, piece.to),
      );
    } else if (piece.kind === 'step') {
      parts.push(
        piece.base === 'start'
          ? words.stepStart(unit, piece.step, piece.from)
          : piece.base === 'range'
            ? words.stepRange(unit, piece.step, piece.from, piece.to)
            : words.everyN(unit, piece.step),
      );
    }
  }
  return words.list(parts);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The times of day when all three fields are plain lists and there are few of them. */
function exactTimes(
  seconds: Sel | undefined,
  minutes: Sel,
  hours: Sel,
  limit: number,
): string[] | undefined {
  if (minutes.kind !== 'values' || hours.kind !== 'values') {
    return undefined;
  }
  if (seconds !== undefined && seconds.kind !== 'values') {
    return undefined;
  }
  const secondValues = seconds?.values ?? [0];
  if (hours.values.length * minutes.values.length * secondValues.length > limit) {
    return undefined;
  }
  const withSeconds = secondValues.some((second) => second !== 0);
  const times: string[] = [];
  for (const hour of hours.values) {
    for (const minute of minutes.values) {
      for (const second of secondValues) {
        times.push(`${pad(hour)}:${pad(minute)}${withSeconds ? `:${pad(second)}` : ''}`);
      }
    }
  }
  return times;
}

/** More times than this are described field by field. */
const MAX_EXACT_TIMES = 8;

function hasStep(selection: Sel): boolean {
  return selection.kind === 'pieces' && selection.pieces.some((piece) => piece.kind === 'step');
}

/** The hours a window "from 09:00 through 17:59" covers, when the hour field is one run. */
function hourWindow(selection: Sel): [number, number] | undefined {
  if (selection.kind === 'values' && selection.values.length === 1) {
    const [hour = 0] = selection.values;
    return [hour, hour];
  }
  if (selection.kind === 'pieces' && selection.pieces.length === 1) {
    const [piece] = selection.pieces;
    if (piece?.kind === 'range') {
      return [piece.from, piece.to];
    }
  }
  return undefined;
}

function timeText(words: Words, schedule: CronSchedule): string {
  const secondSel = schedule.second === undefined ? undefined : selectionOf(schedule.second);
  const seconds =
    secondSel?.kind === 'values' && secondSel.values.length === 1 && secondSel.values[0] === 0
      ? undefined
      : secondSel;
  const minutes = selectionOf(schedule.minute);
  const hours = selectionOf(schedule.hour);

  const times = exactTimes(seconds, minutes, hours, MAX_EXACT_TIMES);
  if (times !== undefined) {
    return words.exactTimes(times);
  }

  // The finest unit that is not fixed decides the sentence; a coarser "any" adds nothing.
  const finestUnit: Unit = seconds === undefined ? 'minute' : 'second';
  const finest = seconds ?? minutes;
  const parent = seconds === undefined ? hours : minutes;
  const parentUnit = seconds === undefined ? 'hour' : 'minute';
  let finestClause = clause(words, finestUnit, finest);
  if (finest.kind !== 'any' && !hasStep(finest) && parent.kind === 'any') {
    finestClause = words.ofEvery(finestClause, parentUnit);
  }

  const window = hourWindow(hours);
  if (
    window !== undefined &&
    (finest.kind === 'any' || finest.kind === 'pieces') &&
    (seconds === undefined || minutes.kind === 'any')
  ) {
    return words.window(finestClause, `${pad(window[0])}:00`, `${pad(window[1])}:59`);
  }

  const parts = [finestClause];
  if (seconds !== undefined && minutes.kind !== 'any') {
    parts.push(clause(words, 'minute', minutes));
  }
  if (hours.kind !== 'any') {
    parts.push(clause(words, 'hour', hours));
  } else if (seconds !== undefined && minutes.kind !== 'any' && !hasStep(minutes)) {
    // "At second 10, at minute 5" happens in every hour: say so.
    const last = parts.length - 1;
    parts[last] = words.ofEvery(parts[last] ?? '', 'hour');
  }
  return parts.join(', ');
}

function weekdayName(locale: Locale, weekday: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2023, 0, 1 + weekday),
  );
}

function monthName(locale: Locale, month: number): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2023, month - 1, 15),
  );
}

/**
 * A set of weekdays or months as text, in calendar order: lone members after the prefix ("on Monday
 * and Wednesday"), runs of three or more as "from X through Y". `order` gives each value its place
 * in a run.
 */
function setText(
  words: Words,
  prefixed: { readonly prefix: string; run(a: string, b: string): string },
  values: readonly number[],
  order: (value: number) => number,
  name: (value: number) => string,
): string {
  const sorted = [...values].sort((a, b) => order(a) - order(b));
  const segments: string[] = [];
  let singles: string[] = [];
  const flush = (): void => {
    if (singles.length > 0) {
      segments.push(prefixed.prefix + words.list(singles));
      singles = [];
    }
  };
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && order(sorted[end + 1] ?? 0) === order(sorted[end] ?? 0) + 1) {
      end += 1;
    }
    if (end - index >= 2) {
      flush();
      segments.push(prefixed.run(name(sorted[index] ?? 0), name(sorted[end] ?? 0)));
    } else {
      for (let at = index; at <= end; at += 1) {
        singles.push(name(sorted[at] ?? 0));
      }
    }
    index = end + 1;
  }
  flush();
  return words.list(segments);
}

function dayOfMonthText(words: Words, field: CronField): string {
  const selection = selectionOf(field);
  const parts: string[] = [];
  if (selection.kind === 'values') {
    if (selection.values.length > 0) {
      parts.push(words.dayValues(selection.values));
    }
  } else if (selection.kind === 'pieces') {
    const values = selection.pieces.flatMap((piece) =>
      piece.kind === 'value' ? [piece.value] : [],
    );
    if (values.length > 0) {
      parts.push(words.dayValues(values));
    }
    for (const piece of selection.pieces) {
      if (piece.kind === 'range') {
        parts.push(words.dayRange(piece.from, piece.to));
      } else if (piece.kind === 'step') {
        parts.push(words.dayStep(piece.step, piece.base, piece.from, piece.to));
      }
    }
  }
  for (const item of field.items) {
    if (item.kind === 'last') {
      parts.push(words.lastDay);
    } else if (item.kind === 'last-weekday') {
      parts.push(words.lastWeekday);
    } else if (item.kind === 'last-offset') {
      parts.push(words.daysBeforeLast(item.offset));
    } else if (item.kind === 'nearest-weekday') {
      parts.push(words.nearestWeekday(item.day));
    }
  }
  return words.list(parts);
}

/** Monday first: the order in which a run of weekdays reads. */
function weekdayOrder(weekday: number): number {
  return (weekday + 6) % 7;
}

function dayOfWeekText(words: Words, field: CronField, locale: Locale): string {
  const parts: string[] = [];
  if (field.values.length > 0 && !field.wildcard) {
    parts.push(
      setText(words, words.weekdays, field.values, weekdayOrder, (weekday) =>
        weekdayName(locale, weekday),
      ),
    );
  }
  for (const item of field.items) {
    if (item.kind === 'last-dow') {
      parts.push(words.lastWeekdayNamed(weekdayName(locale, item.weekday)));
    } else if (item.kind === 'nth-dow') {
      parts.push(words.nthWeekdayNamed(item.nth, weekdayName(locale, item.weekday)));
    }
  }
  return words.list(parts);
}

function dayText(words: Words, schedule: CronSchedule, locale: Locale): string {
  const dom = dayOfMonthText(words, schedule.dayOfMonth);
  const dow = dayOfWeekText(words, schedule.dayOfWeek, locale);
  switch (schedule.dayRule) {
    case 'all':
      return '';
    case 'dom':
      return dom;
    case 'dow':
      return dow;
    case 'and':
      return dom === '' || dow === '' ? dom + dow : words.and(dom, dow);
    case 'or':
      // A free field (`1-31`, `0-6`) without a star matches every day: nothing is left to say.
      return dom === '' || dow === '' ? '' : words.or(dom, dow);
  }
}

function monthText(words: Words, field: CronField, locale: Locale): string {
  return field.wildcard
    ? ''
    : setText(
        words,
        words.months,
        field.values,
        (month) => month,
        (month) => monthName(locale, month),
      );
}

function yearText(words: Words, field: CronField | undefined): string {
  if (field === undefined) {
    return '';
  }
  const selection = selectionOf(field);
  if (selection.kind === 'any') {
    return '';
  }
  if (selection.kind === 'values') {
    return words.yearValues(selection.values);
  }
  const values = selection.pieces.flatMap((piece) => (piece.kind === 'value' ? [piece.value] : []));
  const parts: string[] = values.length > 0 ? [words.yearValues(values)] : [];
  for (const piece of selection.pieces) {
    if (piece.kind === 'range') {
      parts.push(words.yearRange(piece.from, piece.to));
    } else if (piece.kind === 'step') {
      parts.push(words.yearStep(piece.step, piece.base, piece.from, piece.to));
    }
  }
  return words.list(parts);
}

/** The schedule as a sentence in `locale`, for example "At 09:00, from Monday through Friday". */
export function explainCron(schedule: CronSchedule, locale: Locale): string {
  const words = WORDS[locale];
  const time = timeText(words, schedule);
  const days = dayText(words, schedule, locale);
  const months = monthText(words, schedule.month, locale);
  const years = yearText(words, schedule.year);
  const onlyTimes = days === '' && months === '' && years === '';
  const parts = [
    time,
    onlyTimes && /^(?:at|um) \d/.test(time) ? words.everyDay : '',
    days,
    months,
    years,
  ].filter((part) => part !== '');
  // "At 09:00 every day": the day word belongs to the time, so it is joined without a comma.
  const sentence = parts.length > 1 && onlyTimes ? parts.join(' ') : parts.join(', ');
  return upperFirst(sentence);
}
