/**
 * CRON expressions: parsing and validation (T-19, issue #24).
 *
 * Three variants are accepted, told apart by the number of fields:
 *
 *  - 5 fields (standard / Vixie cron): minute hour day-of-month month day-of-week
 *  - 6 fields (seconds first, as in Quartz, Spring, croner): second minute hour day-of-month month day-of-week
 *  - 7 fields (Quartz): the six above plus a year
 *
 * plus the macros `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`.
 * Every field takes `*`, lists (`1,5`), ranges (`1-5`), steps (star with a step, `10/15`, `0-30/10`) and, where the
 * field has them, names (`JAN`, `MON`). The 6- and 7-field forms also take the Quartz extras: `?`
 * (no specific value) and `L`, `L-n`, `LW`, `nW` for the day of month, `nL` and `n#k` for the day of week.
 *
 * Day-of-week numbers follow the Unix convention (0 and 7 are Sunday, 1 is Monday), also in the Quartz
 * forms, where they start on Sunday = 1; write names there. Ranges do not wrap (`22-2` is an error, write
 * `22-23,0-2`).
 *
 * Pure functions, no I/O; nothing here throws for any input.
 */

export type CronFieldName =
  'second' | 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek' | 'year';

export type CronDialect = 'standard' | 'seconds' | 'quartz';

/** Why a text is not a CRON expression. The tool turns each code into a message. */
export type CronErrorCode =
  | 'empty'
  | 'too-long'
  | 'field-count'
  | 'unknown-macro'
  | 'reboot'
  | 'empty-item'
  | 'syntax'
  | 'out-of-range'
  | 'range-order'
  | 'step-zero'
  | 'step-too-large'
  | 'unsupported-special'
  | 'bad-nth';

export interface CronError {
  readonly code: CronErrorCode;
  readonly field?: CronFieldName;
  /** The part of the text that is wrong. */
  readonly token?: string;
  /** The allowed range, for `out-of-range`; the largest step, for `step-too-large`. */
  readonly min?: number;
  readonly max?: number;
  /** The number of fields found, for `field-count`. */
  readonly count?: number;
}

/** One comma-separated part of a field. */
export type CronItem =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | {
      readonly kind: 'step';
      readonly from: number;
      readonly to: number;
      readonly step: number;
      /** Star with a step (any), `a/n` (start) or `a-b/n` (range). */
      readonly base: 'any' | 'start' | 'range';
    }
  | { readonly kind: 'last' }
  | { readonly kind: 'last-offset'; readonly offset: number }
  | { readonly kind: 'last-weekday' }
  | { readonly kind: 'nearest-weekday'; readonly day: number }
  | { readonly kind: 'last-dow'; readonly weekday: number }
  | { readonly kind: 'nth-dow'; readonly weekday: number; readonly nth: number };

export interface CronField {
  readonly name: CronFieldName;
  /** The text as written. */
  readonly text: string;
  /** The text starts with `*` or is `?`: the "star" of Vixie cron (see `dayRule`). */
  readonly star: boolean;
  readonly items: readonly CronItem[];
  /** The numbers of the plain items (value, range, step), sorted, unique; Sunday is 0. */
  readonly values: readonly number[];
  /** The plain items cover the whole domain and there is no special item. */
  readonly wildcard: boolean;
}

/**
 * Which days a schedule runs on, from the two day fields (Vixie cron):
 * `all`: both are free; `dom` / `dow`: only that one restricts; `and`: both restrict and one of them
 * starts with `*`, so a day has to match both; `or`: both restrict, a day matches either.
 */
export type DayRule = 'all' | 'dom' | 'dow' | 'and' | 'or';

export interface CronSchedule {
  readonly dialect: CronDialect;
  /** The expression with single spaces and the macro (if any) spelled out. */
  readonly normalized: string;
  /** The macro the text started with, for example `@daily`. */
  readonly macro: string | undefined;
  readonly second: CronField | undefined;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
  readonly year: CronField | undefined;
  readonly dayRule: DayRule;
}

export type CronParseResult =
  | { readonly ok: true; readonly schedule: CronSchedule }
  | { readonly ok: false; readonly errors: readonly CronError[] };

/** The longest text that is looked at; a CRON expression is far shorter. */
export const MAX_LENGTH = 500;

interface FieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
  /** The range that `*` stands for (the day of week has 7 as an alias of 0). */
  readonly starMax: number;
  /** Three-letter names; the first one has the value `nameBase`. */
  readonly names: readonly string[] | undefined;
  readonly nameBase: number;
}

export const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

export const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export const YEAR_MIN = 1970;
export const YEAR_MAX = 2199;

export const SPECS: Readonly<Record<CronFieldName, FieldSpec>> = {
  second: { name: 'second', min: 0, max: 59, starMax: 59, names: undefined, nameBase: 0 },
  minute: { name: 'minute', min: 0, max: 59, starMax: 59, names: undefined, nameBase: 0 },
  hour: { name: 'hour', min: 0, max: 23, starMax: 23, names: undefined, nameBase: 0 },
  dayOfMonth: { name: 'dayOfMonth', min: 1, max: 31, starMax: 31, names: undefined, nameBase: 1 },
  month: { name: 'month', min: 1, max: 12, starMax: 12, names: MONTH_NAMES, nameBase: 1 },
  dayOfWeek: { name: 'dayOfWeek', min: 0, max: 7, starMax: 6, names: WEEKDAY_NAMES, nameBase: 0 },
  year: {
    name: 'year',
    min: YEAR_MIN,
    max: YEAR_MAX,
    starMax: YEAR_MAX,
    names: undefined,
    nameBase: 0,
  },
};

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const FIELD_ORDER: Readonly<Record<CronDialect, readonly CronFieldName[]>> = {
  standard: ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'],
  seconds: ['second', 'minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'],
  quartz: ['second', 'minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek', 'year'],
};

const DIALECT_BY_COUNT: Readonly<Record<number, CronDialect>> = {
  5: 'standard',
  6: 'seconds',
  7: 'quartz',
};

/** The field's size, which is also the largest sensible step. */
function domainSize(spec: FieldSpec): number {
  return spec.starMax - spec.min + 1;
}

/** A number or a name of the field, or `undefined` when the token is neither. */
function parseValue(token: string, spec: FieldSpec): number | undefined {
  if (/^\d{1,4}$/.test(token)) {
    return Number(token);
  }
  if (spec.names !== undefined && /^[A-Za-z]{3}$/.test(token)) {
    const index = spec.names.indexOf(token.toUpperCase());
    return index < 0 ? undefined : index + spec.nameBase;
  }
  return undefined;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += step) {
    out.push(value);
  }
  return out;
}

type PlainItem = Extract<CronItem, { readonly kind: 'value' | 'range' | 'step' }>;

type ItemResult =
  | { readonly ok: true; readonly item: CronItem; readonly values: readonly number[] }
  | { readonly ok: false; readonly error: CronError };

class ItemParser {
  readonly #spec: FieldSpec;
  readonly #special: boolean;

  constructor(spec: FieldSpec, special: boolean) {
    this.#spec = spec;
    this.#special = special;
  }

  #fail(code: CronErrorCode, token: string, extra?: Partial<CronError>): ItemResult {
    return { ok: false, error: { code, field: this.#spec.name, token, ...extra } };
  }

  #outOfRange(token: string): ItemResult {
    return this.#fail('out-of-range', token, { min: this.#spec.min, max: this.#spec.max });
  }

  /** Validates a value and returns it, or the error to report. */
  #value(text: string, token: string): number | ItemResult {
    const value = parseValue(text, this.#spec);
    if (value === undefined) {
      return this.#fail('syntax', token);
    }
    return value < this.#spec.min || value > this.#spec.max ? this.#outOfRange(token) : value;
  }

  parse(token: string): ItemResult {
    const spec = this.#spec;
    if (token === '') {
      return this.#fail('empty-item', token);
    }
    if (token === '*') {
      return this.#plain({ kind: 'range', from: spec.min, to: spec.starMax }, 1);
    }
    const specialResult = this.#parseSpecial(token);
    if (specialResult !== undefined) {
      return specialResult;
    }
    const slash = token.indexOf('/');
    const base = slash < 0 ? token : token.slice(0, slash);
    const stepText = slash < 0 ? undefined : token.slice(slash + 1);
    let from: number;
    let to: number;
    let shape: 'any' | 'range' | 'single';
    if (base === '*') {
      from = spec.min;
      to = spec.starMax;
      shape = 'any';
    } else if (/^[^-]+-[^-]+$/.test(base)) {
      const [left = '', right = ''] = base.split('-');
      const a = this.#value(left, token);
      if (typeof a !== 'number') {
        return a;
      }
      const b = this.#value(right, token);
      if (typeof b !== 'number') {
        return b;
      }
      if (a > b) {
        return this.#fail('range-order', token);
      }
      from = a;
      to = b;
      shape = 'range';
    } else {
      const a = this.#value(base, token);
      if (typeof a !== 'number') {
        return a;
      }
      from = a;
      to = stepText === undefined ? a : spec.max;
      shape = 'single';
    }
    if (stepText === undefined) {
      return shape === 'single'
        ? this.#plain({ kind: 'value', value: from }, 1)
        : this.#plain({ kind: 'range', from, to }, 1);
    }
    if (!/^\d{1,4}$/.test(stepText)) {
      return this.#fail('syntax', token);
    }
    const step = Number(stepText);
    if (step === 0) {
      return this.#fail('step-zero', token);
    }
    if (step > domainSize(spec)) {
      return this.#fail('step-too-large', token, { max: domainSize(spec) });
    }
    const stepBase = shape === 'single' ? 'start' : shape;
    return this.#plain({ kind: 'step', from, to, step, base: stepBase }, step);
  }

  /** A numeric item and the numbers it stands for (Sunday as 7 becomes 0). */
  #plain(item: PlainItem, step: number): ItemResult {
    const from = item.kind === 'value' ? item.value : item.from;
    const to = item.kind === 'value' ? item.value : item.to;
    const numbers = range(from, to, step);
    const values = this.#spec.name === 'dayOfWeek' ? numbers.map((n) => n % 7) : numbers;
    return { ok: true, item, values };
  }

  /** `?`, `L`, `L-n`, `LW`, `nW`, `nL`, `n#k`; `undefined` when the token is none of them. */
  #parseSpecial(token: string): ItemResult | undefined {
    const spec = this.#spec;
    const isDay = spec.name === 'dayOfMonth';
    const isWeekday = spec.name === 'dayOfWeek';
    if (!isDay && !isWeekday) {
      return undefined;
    }
    const upper = token.toUpperCase();
    const patterns = isDay
      ? /^(?:\?|L|L-\d{1,3}|LW|\d{1,3}W)$/
      : /^(?:\?|[A-Z0-9]{1,3}L|[A-Z0-9]{1,3}#\d{1,3})$/;
    if (!patterns.test(upper)) {
      return undefined;
    }
    if (!this.#special) {
      return this.#fail('unsupported-special', token);
    }
    if (upper === '?') {
      return this.#plain({ kind: 'range', from: spec.min, to: spec.starMax }, 1);
    }
    const none: readonly number[] = [];
    if (isDay) {
      if (upper === 'L') {
        return { ok: true, item: { kind: 'last' }, values: none };
      }
      if (upper === 'LW') {
        return { ok: true, item: { kind: 'last-weekday' }, values: none };
      }
      if (upper.startsWith('L-')) {
        const offset = Number(upper.slice(2));
        return offset < 1 || offset > 30
          ? this.#fail('out-of-range', token, { min: 1, max: 30 })
          : { ok: true, item: { kind: 'last-offset', offset }, values: none };
      }
      const day = Number(upper.slice(0, -1));
      return day < 1 || day > 31
        ? this.#outOfRange(token)
        : { ok: true, item: { kind: 'nearest-weekday', day }, values: none };
    }
    if (upper.endsWith('L')) {
      const weekday = parseValue(token.slice(0, -1), spec);
      if (weekday === undefined) {
        return this.#fail('syntax', token);
      }
      return weekday > 7
        ? this.#outOfRange(token)
        : { ok: true, item: { kind: 'last-dow', weekday: weekday % 7 }, values: none };
    }
    const [left = '', right = ''] = token.split('#');
    const weekday = parseValue(left, spec);
    if (weekday === undefined) {
      return this.#fail('syntax', token);
    }
    if (weekday > 7) {
      return this.#outOfRange(token);
    }
    const nth = Number(right);
    return nth < 1 || nth > 5
      ? this.#fail('bad-nth', token, { min: 1, max: 5 })
      : { ok: true, item: { kind: 'nth-dow', weekday: weekday % 7, nth }, values: none };
  }
}

type FieldResult =
  | { readonly ok: true; readonly field: CronField }
  | { readonly ok: false; readonly errors: readonly CronError[] };

function parseField(name: CronFieldName, text: string, special: boolean): FieldResult {
  const spec = SPECS[name];
  const parser = new ItemParser(spec, special);
  const items: CronItem[] = [];
  const errors: CronError[] = [];
  const numbers = new Set<number>();
  for (const token of text.split(',')) {
    const result = parser.parse(token);
    if (result.ok) {
      items.push(result.item);
      for (const value of result.values) {
        numbers.add(value);
      }
    } else {
      errors.push(result.error);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const values = [...numbers].sort((a, b) => a - b);
  const plainOnly = items.every(
    (item) => item.kind === 'value' || item.kind === 'range' || item.kind === 'step',
  );
  const size = spec.name === 'dayOfWeek' ? 7 : spec.starMax - spec.min + 1;
  return {
    ok: true,
    field: {
      name,
      text,
      star: text.startsWith('*') || text === '?',
      items,
      values,
      wildcard: plainOnly && values.length === size,
    },
  };
}

function dayRuleOf(dayOfMonth: CronField, dayOfWeek: CronField): DayRule {
  const domFree = dayOfMonth.star && dayOfMonth.wildcard;
  const dowFree = dayOfWeek.star && dayOfWeek.wildcard;
  if (domFree && dowFree) {
    return 'all';
  }
  if (dowFree) {
    return 'dom';
  }
  if (domFree) {
    return 'dow';
  }
  return dayOfMonth.star || dayOfWeek.star ? 'and' : 'or';
}

/** Splits the text into its fields; a macro is replaced by the five fields it stands for. */
function tokenize(
  input: string,
): { ok: true; tokens: string[]; macro: string | undefined } | { ok: false; error: CronError } {
  const tokens = input.trim().split(/\s+/);
  const first = tokens[0] ?? '';
  if (!first.startsWith('@')) {
    return { ok: true, tokens, macro: undefined };
  }
  const macro = first.toLowerCase();
  if (macro === '@reboot' && tokens.length === 1) {
    return { ok: false, error: { code: 'reboot', token: first } };
  }
  const expansion = tokens.length === 1 ? MACROS[macro] : undefined;
  if (expansion === undefined) {
    return { ok: false, error: { code: 'unknown-macro', token: first } };
  }
  return { ok: true, tokens: expansion.split(' '), macro };
}

/** Parses and validates a CRON expression; reports every problem it finds, never throws. */
export function parseCron(input: string): CronParseResult {
  if (input.trim() === '') {
    return { ok: false, errors: [{ code: 'empty' }] };
  }
  if (input.length > MAX_LENGTH) {
    return { ok: false, errors: [{ code: 'too-long', max: MAX_LENGTH }] };
  }
  const split = tokenize(input);
  if (!split.ok) {
    return { ok: false, errors: [split.error] };
  }
  const dialect = DIALECT_BY_COUNT[split.tokens.length];
  if (dialect === undefined) {
    return { ok: false, errors: [{ code: 'field-count', count: split.tokens.length }] };
  }
  const names = FIELD_ORDER[dialect];
  const special = dialect !== 'standard';
  const fields = new Map<CronFieldName, CronField>();
  const errors: CronError[] = [];
  names.forEach((name, index) => {
    const result = parseField(name, split.tokens[index] ?? '', special);
    if (result.ok) {
      fields.set(name, result.field);
    } else {
      errors.push(...result.errors);
    }
  });
  const minute = fields.get('minute');
  const hour = fields.get('hour');
  const dayOfMonth = fields.get('dayOfMonth');
  const month = fields.get('month');
  const dayOfWeek = fields.get('dayOfWeek');
  if (
    errors.length > 0 ||
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    schedule: {
      dialect,
      normalized: split.tokens.join(' '),
      macro: split.macro,
      second: fields.get('second'),
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
      year: fields.get('year'),
      dayRule: dayRuleOf(dayOfMonth, dayOfWeek),
    },
  };
}

/** Days in a month (`month` 1 to 12) of a year. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The weekday of a date, Sunday = 0. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

/** The days of the month that the day-of-month field selects, sorted. */
function domDays(field: CronField, year: number, month: number): Set<number> {
  const size = daysInMonth(year, month);
  const days = new Set(field.values.filter((day) => day <= size));
  for (const item of field.items) {
    if (item.kind === 'last') {
      days.add(size);
    } else if (item.kind === 'last-offset') {
      if (size - item.offset >= 1) {
        days.add(size - item.offset);
      }
    } else if (item.kind === 'last-weekday') {
      const weekday = weekdayOf(year, month, size);
      days.add(weekday === 6 ? size - 1 : weekday === 0 ? size - 2 : size);
    } else if (item.kind === 'nearest-weekday' && item.day <= size) {
      const weekday = weekdayOf(year, month, item.day);
      if (isWeekday(weekday)) {
        days.add(item.day);
      } else if (weekday === 6) {
        days.add(item.day > 1 ? item.day - 1 : item.day + 2);
      } else {
        days.add(item.day < size ? item.day + 1 : item.day - 2);
      }
    }
  }
  return days;
}

/** The days of the month that the day-of-week field selects. */
function dowDays(field: CronField, year: number, month: number): Set<number> {
  const size = daysInMonth(year, month);
  const days = new Set<number>();
  const weekdays = new Set(field.values);
  for (let day = 1; day <= size; day += 1) {
    if (weekdays.has(weekdayOf(year, month, day))) {
      days.add(day);
    }
  }
  for (const item of field.items) {
    if (item.kind === 'last-dow') {
      for (let day = size; day >= size - 6; day -= 1) {
        if (weekdayOf(year, month, day) === item.weekday) {
          days.add(day);
          break;
        }
      }
    } else if (item.kind === 'nth-dow') {
      const first = 1 + ((item.weekday - weekdayOf(year, month, 1) + 7) % 7);
      const day = first + 7 * (item.nth - 1);
      if (day <= size) {
        days.add(day);
      }
    }
  }
  return days;
}

/** The days of a month (1 to 12) on which the schedule runs, ascending. */
export function matchingDays(schedule: CronSchedule, year: number, month: number): number[] {
  const size = daysInMonth(year, month);
  const all = range(1, size, 1);
  const rule = schedule.dayRule;
  if (rule === 'all') {
    return all;
  }
  const dom = domDays(schedule.dayOfMonth, year, month);
  const dow = dowDays(schedule.dayOfWeek, year, month);
  if (rule === 'dom') {
    return all.filter((day) => dom.has(day));
  }
  if (rule === 'dow') {
    return all.filter((day) => dow.has(day));
  }
  return rule === 'and'
    ? all.filter((day) => dom.has(day) && dow.has(day))
    : all.filter((day) => dom.has(day) || dow.has(day));
}
