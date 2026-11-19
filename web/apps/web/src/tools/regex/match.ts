import type { TaskContext } from '@stuffcloud/tools';

/** What the page sends to the worker. */
export interface Input {
  readonly pattern: string;
  readonly flags: string;
  readonly text: string;
  /** Stop after this many matches. */
  readonly maxMatches: number;
}

export interface Match {
  /** Where the match starts (in UTF-16 code units, like `String.prototype.indexOf`). */
  readonly index: number;
  readonly text: string;
  /** The numbered groups 1, 2, ...; `undefined` for a group that did not take part. */
  readonly groups: readonly (string | undefined)[];
  /** The named groups, in the order of the pattern. */
  readonly named: readonly (readonly [name: string, value: string | undefined])[];
}

export interface Output {
  readonly matches: readonly Match[];
  /** More matches exist than `maxMatches`. */
  readonly truncated: boolean;
}

/** The flags a pattern can be tested with, in the order the page shows them. */
export const FLAGS = ['g', 'i', 'm', 's', 'u', 'v', 'y'] as const;
export type Flag = (typeof FLAGS)[number];

export const MAX_PATTERN_LENGTH = 2000;
export const MAX_TEXT_LENGTH = 200_000;
export const MAX_MATCHES = 1000;

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['pattern'] === 'string' &&
    typeof record['flags'] === 'string' &&
    typeof record['text'] === 'string' &&
    typeof record['maxMatches'] === 'number' &&
    Number.isSafeInteger(record['maxMatches']) &&
    record['maxMatches'] >= 1
  );
}

/** The error a browser gives for a pattern or flags it cannot compile, or `undefined` when they are fine. */
export function compileError(pattern: string, flags: string): string | undefined {
  try {
    new RegExp(pattern, flags);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Finds the matches. A pattern can take exponential time on some texts (nested repetition that has to
 * backtrack), and JavaScript cannot interrupt a running match: this runs in a worker, and the page
 * ends the worker when it takes too long. It must not touch the DOM.
 */
export function findMatches(input: Input, context?: TaskContext): Output {
  const expression = new RegExp(input.pattern, input.flags);
  const repeats = expression.global || expression.sticky;
  const unicode = input.flags.includes('u') || input.flags.includes('v');
  const matches: Match[] = [];
  let truncated = false;
  for (;;) {
    const found = expression.exec(input.text);
    if (found === null) {
      break;
    }
    if (matches.length >= input.maxMatches) {
      truncated = true;
      break;
    }
    const numbered = found.slice(1);
    const named = found.groups === undefined ? [] : Object.entries(found.groups);
    matches.push({ index: found.index, text: found[0], groups: numbered, named });
    if (!repeats) {
      break;
    }
    if (found[0] === '') {
      // An empty match does not move the position: step over one character (a whole code point with `u` or `v`).
      const step = unicode ? (input.text.codePointAt(expression.lastIndex) ?? 0) > 0xffff : false;
      expression.lastIndex += step ? 2 : 1;
    }
  }
  context?.progress(1, 1);
  return { matches, truncated };
}

/** The work of the tool (see {@link findMatches}). */
export function runTask(input: Input, context: TaskContext): Output {
  return findMatches(input, context);
}

/** The page waits this long after the last edit before it matches. */
export const DEBOUNCE_MS = 250;
/** A match that takes longer is stopped (it is most likely backtracking without end). */
export const MATCH_TIMEOUT_MS = 2000;
