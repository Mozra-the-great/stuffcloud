/**
 * Find and replace. A pattern the visitor writes can be slow (nested repeats), so this runs in the
 * worker like everything else in the tool, and the page stops the worker on a timeout.
 */

export interface ReplaceOptions {
  readonly find: string;
  readonly replacement: string;
  /** `find` is a regular expression, and `$1`, `$&` and `$<name>` work in the replacement. */
  readonly regex: boolean;
  readonly ignoreCase: boolean;
  /** Only whole words match: a letter, digit or underscore may not touch the match. */
  readonly wholeWord: boolean;
}

export type ReplaceError =
  { readonly code: 'find-empty' } | { readonly code: 'pattern'; readonly message: string };

export type ReplaceResult =
  | { readonly ok: true; readonly text: string; readonly count: number }
  | { readonly ok: false; readonly error: ReplaceError };

export const MAX_FIND_LENGTH = 1000;

const BACKSLASH = String.fromCharCode(92);
const SYNTAX = '^$.*+?()[]{}|/-';

/** The text as a pattern that matches exactly it. */
export function escapePattern(text: string): string {
  let escaped = '';
  for (const character of text) {
    escaped +=
      character === BACKSLASH || SYNTAX.includes(character) ? BACKSLASH + character : character;
  }
  return escaped;
}

/** The compiled pattern, or the browser's message about why it cannot be. */
export function compile(
  options: ReplaceOptions,
): { ok: true; pattern: RegExp } | { ok: false; message: string } {
  const body = options.regex ? options.find : escapePattern(options.find);
  const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
  try {
    return { ok: true, pattern: new RegExp(source, `gmu${options.ignoreCase ? 'i' : ''}`) };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function replaceText(text: string, options: ReplaceOptions): ReplaceResult {
  if (options.find === '') {
    return { ok: false, error: { code: 'find-empty' } };
  }
  const compiled = compile(options);
  if (!compiled.ok) {
    return { ok: false, error: { code: 'pattern', message: compiled.message } };
  }
  const { pattern } = compiled;
  if (options.regex) {
    // The browser expands `$1`, `$&` and `$<name>` itself; the matches are counted in a second pass.
    const count = (text.match(pattern) ?? []).length;
    return { ok: true, text: text.replace(pattern, options.replacement), count };
  }
  let count = 0;
  // A function as the replacement keeps `$` in the replacement a plain character.
  const replaced = text.replace(pattern, () => {
    count += 1;
    return options.replacement;
  });
  return { ok: true, text: replaced, count };
}
