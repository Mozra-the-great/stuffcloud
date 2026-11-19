import { matchingDays, YEAR_MAX, type CronField, type CronSchedule } from './cron.ts';
import { instantsOf, offsetsAround, wallTimeAt } from './time-zone.ts';

export const MIN_RUNS = 1;
export const MAX_RUNS = 50;
export const DEFAULT_RUNS = 10;

export interface NextRunsOptions {
  /** Instant (milliseconds since the epoch); only runs after it count. */
  readonly from: number;
  /** How many runs, `MIN_RUNS` to `MAX_RUNS`. */
  readonly count: number;
  /** An IANA time zone name the browser knows. */
  readonly timeZone: string;
}

export interface NextRuns {
  /** Instants in ascending order. */
  readonly runs: readonly number[];
  /** There are fewer runs than asked for because the schedule ends (or never runs). */
  readonly exhausted: boolean;
}

function numbers(field: CronField | undefined, fallback: readonly number[]): readonly number[] {
  return field === undefined ? fallback : field.values;
}

const SECOND_ZERO: readonly number[] = [0];

/** The next runs of a schedule in a time zone, wall-clock based like cron. */
export function nextRuns(schedule: CronSchedule, options: NextRunsOptions): NextRuns {
  const count = Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.trunc(options.count)));
  const start = wallTimeAt(options.from, options.timeZone);
  const seconds = numbers(schedule.second, SECOND_ZERO);
  const minutes = schedule.minute.values;
  const hours = schedule.hour.values;
  const months = schedule.month.values;
  const years = schedule.year?.wildcard === false ? numbers(schedule.year, []) : undefined;
  const repeatsEveryHour = schedule.hour.wildcard;
  const runs: number[] = [];

  for (let year = start.year; year <= YEAR_MAX && runs.length < count; year += 1) {
    if (years !== undefined && !years.includes(year)) {
      continue;
    }
    for (const month of months) {
      if (year === start.year && month < start.month) {
        continue;
      }
      for (const day of matchingDays(schedule, year, month)) {
        if (year === start.year && month === start.month && day < start.day) {
          continue;
        }
        const dayStart = Date.UTC(year, month - 1, day);
        const offsets = offsetsAround(dayStart, options.timeZone);
        // On a day with a clock change the instants are collected and sorted: a repeated hour
        // puts later wall-clock times before earlier ones.
        const changes = offsets.before !== offsets.after;
        const instants: number[] = [];
        for (const hour of hours) {
          for (const minute of minutes) {
            for (const second of seconds) {
              const wall = dayStart + ((hour * 60 + minute) * 60 + second) * 1000;
              const candidates = instantsOf(wall, offsets);
              // A time that happens twice runs twice only when the schedule runs in every hour.
              const taken = repeatsEveryHour ? candidates : candidates.slice(0, 1);
              for (const instant of taken) {
                if (instant <= options.from) {
                  continue;
                }
                if (!changes) {
                  runs.push(instant);
                  if (runs.length === count) {
                    return { runs, exhausted: false };
                  }
                } else {
                  instants.push(instant);
                }
              }
            }
          }
        }
        instants.sort((a, b) => a - b);
        for (const instant of instants) {
          runs.push(instant);
          if (runs.length === count) {
            return { runs, exhausted: false };
          }
        }
      }
    }
  }
  return { runs, exhausted: true };
}
