/**
 * Operations on the lines of a text: sort, remove duplicates, trim, number. A final line break is
 * not a line of its own: it is kept at the end of the result, so a text that ended with one still
 * does.
 */

/** Splits a text into lines (CRLF or LF) and tells whether it ended with a line break. */
export function splitLines(text: string): { lines: string[]; trailingBreak: boolean } {
  if (text === '') {
    return { lines: [], trailingBreak: false };
  }
  const lines = text.split(/\r?\n/);
  const trailingBreak = lines[lines.length - 1] === '';
  if (trailingBreak) {
    lines.pop();
  }
  return { lines, trailingBreak };
}

export function joinLines(lines: readonly string[], trailingBreak: boolean): string {
  return lines.length === 0 ? '' : lines.join('\n') + (trailingBreak ? '\n' : '');
}

export interface SortOptions {
  readonly descending: boolean;
  readonly ignoreCase: boolean;
  /** Numbers inside the lines count by value: `item 2` comes before `item 10`. */
  readonly numeric: boolean;
  /** BCP 47 language tag the order follows (the order of ä, é, ... differs by language). */
  readonly locale: string;
}

export function sortLines(text: string, options: SortOptions): string {
  const { lines, trailingBreak } = splitLines(text);
  const collator = new Intl.Collator(options.locale, {
    numeric: options.numeric,
    sensitivity: options.ignoreCase ? 'accent' : 'variant',
  });
  const sorted = [...lines].sort((a, b) => collator.compare(a, b));
  if (options.descending) {
    sorted.reverse();
  }
  return joinLines(sorted, trailingBreak);
}

export interface DedupeOptions {
  readonly ignoreCase: boolean;
  /** Lines that differ in white space only (leading, trailing, repeated) are the same line. */
  readonly ignoreWhitespace: boolean;
}

/** The first of each group of equal lines stays, in its place; `removed` counts the others. */
export function dedupeLines(
  text: string,
  options: DedupeOptions,
): { text: string; removed: number } {
  const { lines, trailingBreak } = splitLines(text);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    let key = options.ignoreWhitespace
      ? line
          .split(/\s+/)
          .filter((word) => word !== '')
          .join(' ')
      : line;
    if (options.ignoreCase) {
      key = key.toLowerCase();
    }
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(line);
    }
  }
  return { text: joinLines(kept, trailingBreak), removed: lines.length - kept.length };
}

export type TrimMode = 'both' | 'start' | 'end';

export interface TrimOptions {
  /** Which ends of each line lose their white space. */
  readonly mode: TrimMode;
  readonly removeEmptyLines: boolean;
  /** Runs of spaces and tabs inside a line become one space. */
  readonly collapse: boolean;
}

export function trimLines(text: string, options: TrimOptions): string {
  const { lines, trailingBreak } = splitLines(text);
  const trimmed = lines.map((line) => {
    let result = line;
    if (options.collapse) {
      result = result.replace(/[ \t]+/g, ' ');
    }
    if (options.mode === 'both') {
      return result.trim();
    }
    return options.mode === 'start' ? result.trimStart() : result.trimEnd();
  });
  const kept = options.removeEmptyLines ? trimmed.filter((line) => line.trim() !== '') : trimmed;
  return joinLines(kept, trailingBreak);
}

export const MAX_START = 1_000_000_000;
export const MAX_SEPARATOR_LENGTH = 10;

export interface NumberOptions {
  readonly start: number;
  readonly separator: string;
  /** Pad the numbers with spaces to the width of the largest one. */
  readonly pad: boolean;
}

export function numberLines(text: string, options: NumberOptions): string {
  const { lines, trailingBreak } = splitLines(text);
  const last = options.start + lines.length - 1;
  const width = options.pad ? Math.max(String(options.start).length, String(last).length) : 0;
  const numbered = lines.map(
    (line, index) =>
      `${String(options.start + index).padStart(width, ' ')}${options.separator}${line}`,
  );
  return joinLines(numbered, trailingBreak);
}
