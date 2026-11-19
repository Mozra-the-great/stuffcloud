const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/**
 * A distance in time in words ("in 3 days", "2 hours ago", "now") in the language of `locale`. `delta` is
 * the moment minus now, in milliseconds: negative is the past. The unit is the largest one that fits at
 * least once; the number is cut, not rounded, so "59 minutes ago" never reads "1 hour ago".
 */
export function relativeTime(delta: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const size = Math.abs(delta);
  if (size < MINUTE) {
    return format.format(Math.trunc(delta / SECOND), 'second');
  }
  if (size < HOUR) {
    return format.format(Math.trunc(delta / MINUTE), 'minute');
  }
  if (size < DAY) {
    return format.format(Math.trunc(delta / HOUR), 'hour');
  }
  if (size < MONTH) {
    return format.format(Math.trunc(delta / DAY), 'day');
  }
  if (size < YEAR) {
    return format.format(Math.trunc(delta / MONTH), 'month');
  }
  return format.format(Math.trunc(delta / YEAR), 'year');
}
