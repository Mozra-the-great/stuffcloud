import { diffArrays, diffWords, diffWordsWithSpace, type ChangeObject } from 'diff';
import type { TaskContext } from '@stuffcloud/tools';

/**
 * The comparison. It runs in a worker (the work of a large or very different pair of texts is long),
 * so it must not touch the DOM; the page stops the worker when it takes too long.
 */

export type DiffUnit = 'lines' | 'words';

export const DIFF_UNITS: readonly DiffUnit[] = ['lines', 'words'];

export interface Input {
  readonly before: string;
  readonly after: string;
  readonly unit: DiffUnit;
  /** Differences in white space only do not count as differences. */
  readonly ignoreWhitespace: boolean;
  /** Unchanged lines kept around each change in the line view; `-1` keeps all of them. */
  readonly context: number;
  /**
   * How long the alignment of the whole text may take. Two texts that share almost nothing need a
   * time that grows with the square of their size; after the budget the result is "everything
   * replaced" (`degraded`) instead of a wait. Defaults to `TIME_BUDGET_MS`.
   */
  readonly budgetMs?: number;
}

export type SegmentKind = 'same' | 'added' | 'removed';

export interface Segment {
  readonly text: string;
  readonly kind: SegmentKind;
}

export type Row =
  | {
      readonly kind: 'same';
      readonly before: number;
      readonly after: number;
      readonly text: string;
    }
  | { readonly kind: 'removed'; readonly before: number; readonly left: readonly Segment[] }
  | { readonly kind: 'added'; readonly after: number; readonly right: readonly Segment[] }
  | {
      readonly kind: 'changed';
      readonly before: number;
      readonly after: number;
      readonly left: readonly Segment[];
      readonly right: readonly Segment[];
    }
  | { readonly kind: 'skipped'; readonly count: number };

export interface Stats {
  /** Lines (line view) or words (word view) that only the new text has. */
  readonly added: number;
  /** Lines or words that only the old text has. */
  readonly removed: number;
  readonly unchanged: number;
}

export type Output =
  | {
      readonly unit: 'lines';
      readonly rows: readonly Row[];
      readonly stats: Stats;
      /** More rows exist than `MAX_ROWS`; the rest is not in `rows`. */
      readonly truncated: boolean;
      /** The texts share too little to be aligned in the time budget: shown as replaced. */
      readonly degraded: boolean;
    }
  | {
      readonly unit: 'words';
      readonly segments: readonly Segment[];
      readonly stats: Stats;
      readonly degraded: boolean;
    };

/** Longest text per side; about one megabyte of text is common, two is the limit. */
export const MAX_TEXT_LENGTH = 2_000_000;
/** Rows the line view carries (after the unchanged runs are folded). */
export const MAX_ROWS = 1000;
/** Lines longer than this are shown as one removed and one added piece, without a word diff. */
export const MAX_INTRA_LINE = 2000;
export const DEFAULT_CONTEXT = 3;
/** The alignment of a whole text may take this long (see `Input.budgetMs`). */
export const TIME_BUDGET_MS = 4000;
/** The page stops the worker after this long, whatever it is doing. */
export const DIFF_TIMEOUT_MS = 15_000;
/** The word diff inside one changed line pair may take this long. */
const PAIR_BUDGET_MS = 100;

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['before'] === 'string' &&
    typeof record['after'] === 'string' &&
    (record['unit'] === 'lines' || record['unit'] === 'words') &&
    typeof record['ignoreWhitespace'] === 'boolean' &&
    typeof record['context'] === 'number' &&
    Number.isSafeInteger(record['context']) &&
    record['context'] >= -1 &&
    (record['budgetMs'] === undefined ||
      (typeof record['budgetMs'] === 'number' && record['budgetMs'] > 0))
  );
}

/** The lines of a text: a final line break does not start another line, and CRLF counts as LF. */
function linesOf(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function toSegments(parts: readonly ChangeObject<string>[]): Segment[] {
  return parts.map((part) => ({
    text: part.value,
    kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
  }));
}

/** The old text's side of a word diff: what is the same, and what was removed. */
export function leftSide(segments: readonly Segment[]): Segment[] {
  return segments.filter((segment) => segment.kind !== 'added');
}

/** The new text's side of a word diff: what is the same, and what was added. */
export function rightSide(segments: readonly Segment[]): Segment[] {
  return segments.filter((segment) => segment.kind !== 'removed');
}

/** The word diff of two texts, or `undefined` when it did not finish within `timeout` milliseconds. */
function wordParts(
  before: string,
  after: string,
  ignoreWhitespace: boolean,
  timeout: number,
): Segment[] | undefined {
  if (before === '' || after === '') {
    // Nothing to align: no search, so no time budget either.
    return [
      ...(before === '' ? [] : [{ text: before, kind: 'removed' as const }]),
      ...(after === '' ? [] : [{ text: after, kind: 'added' as const }]),
    ];
  }
  const parts = ignoreWhitespace
    ? diffWords(before, after, { timeout })
    : diffWordsWithSpace(before, after, { timeout });
  return parts === undefined ? undefined : toSegments(parts);
}

function plain(text: string, kind: SegmentKind): readonly Segment[] {
  return [{ text, kind }];
}

interface Pair {
  readonly left: readonly Segment[];
  readonly right: readonly Segment[];
}

/** A changed line pair: the words that differ are marked, unless the lines are very long. */
function pair(before: string, after: string, ignoreWhitespace: boolean): Pair {
  if (before.length > MAX_INTRA_LINE || after.length > MAX_INTRA_LINE) {
    return { left: plain(before, 'removed'), right: plain(after, 'added') };
  }
  const parts = wordParts(before, after, ignoreWhitespace, PAIR_BUDGET_MS);
  if (parts === undefined) {
    return { left: plain(before, 'removed'), right: plain(after, 'added') };
  }
  return { left: leftSide(parts), right: rightSide(parts) };
}

/** What the comparison of two lists of lines says: runs of the same, removed and added lines. */
interface LineRun {
  readonly kind: SegmentKind;
  readonly count: number;
}

/**
 * Compares the lines by a key: the line itself, or, when white space does not count, the line with
 * its runs of white space made into one space and its ends trimmed. `undefined` when the time budget
 * is used up.
 */
function alignLines(
  old: readonly string[],
  fresh: readonly string[],
  ignoreWhitespace: boolean,
  timeout: number,
): LineRun[] | undefined {
  if (old.length === 0 || fresh.length === 0) {
    return [
      ...(old.length === 0 ? [] : [{ kind: 'removed' as const, count: old.length }]),
      ...(fresh.length === 0 ? [] : [{ kind: 'added' as const, count: fresh.length }]),
    ];
  }
  const key = (line: string): string =>
    ignoreWhitespace
      ? line
          .split(/\s+/)
          .filter((word) => word !== '')
          .join(' ')
      : line;
  const parts = diffArrays(old.map(key), fresh.map(key), { timeout });
  if (parts === undefined) {
    return undefined;
  }
  return parts.map((part) => ({
    kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
    count: part.count,
  }));
}

function lineRows(input: Input): { rows: Row[]; stats: Stats; degraded: boolean } {
  const old = linesOf(input.before);
  const fresh = linesOf(input.after);
  const found = alignLines(old, fresh, input.ignoreWhitespace, input.budgetMs ?? TIME_BUDGET_MS);
  const degraded = found === undefined;
  const runs = found ?? [
    { kind: 'removed' as const, count: old.length },
    { kind: 'added' as const, count: fresh.length },
  ];
  const rows: Row[] = [];
  let before = 0;
  let after = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run === undefined || run.count === 0) {
      continue;
    }
    if (run.kind === 'same') {
      for (const text of fresh.slice(after, after + run.count)) {
        before += 1;
        after += 1;
        unchanged += 1;
        rows.push({ kind: 'same', before, after, text });
      }
      continue;
    }
    // A removed run directly followed by an added run is a change: the lines are paired.
    const next = runs[index + 1];
    const gone = run.kind === 'removed' ? old.slice(before, before + run.count) : [];
    let came = run.kind === 'added' ? fresh.slice(after, after + run.count) : [];
    if (run.kind === 'removed' && next?.kind === 'added') {
      came = fresh.slice(after, after + next.count);
      index += 1;
    }
    const paired = Math.min(gone.length, came.length);
    for (let line = 0; line < paired; line += 1) {
      before += 1;
      after += 1;
      added += 1;
      removed += 1;
      const { left, right } = pair(gone[line] ?? '', came[line] ?? '', input.ignoreWhitespace);
      rows.push({ kind: 'changed', before, after, left, right });
    }
    for (const text of gone.slice(paired)) {
      before += 1;
      removed += 1;
      rows.push({ kind: 'removed', before, left: plain(text, 'removed') });
    }
    for (const text of came.slice(paired)) {
      after += 1;
      added += 1;
      rows.push({ kind: 'added', after, right: plain(text, 'added') });
    }
  }
  return { rows, stats: { added, removed, unchanged }, degraded };
}

/**
 * Folds runs of unchanged rows into one "skipped" row, keeping `context` rows next to each change.
 * A run that would hide a single row is kept (a "1 line skipped" row says less than the line).
 */
export function fold(rows: readonly Row[], context: number): Row[] {
  if (context < 0) {
    return [...rows];
  }
  const keep = new Array<boolean>(rows.length).fill(false);
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'same') {
      continue;
    }
    for (
      let near = Math.max(0, index - context);
      near <= Math.min(rows.length - 1, index + context);
      near += 1
    ) {
      keep[near] = true;
    }
  }
  const folded: Row[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) {
      break;
    }
    if (keep[index] === true || row.kind !== 'same') {
      folded.push(row);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && keep[end] !== true) {
      end += 1;
    }
    const count = end - index;
    if (count === 1) {
      folded.push(row);
    } else {
      folded.push({ kind: 'skipped', count });
    }
    index = end;
  }
  return folded;
}

function wordsOf(segments: readonly Segment[]): Stats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const segment of segments) {
    const count = segment.text.split(/\s+/).filter((word) => word !== '').length;
    if (segment.kind === 'added') {
      added += count;
    } else if (segment.kind === 'removed') {
      removed += count;
    } else {
      unchanged += count;
    }
  }
  return { added, removed, unchanged };
}

/** The work of the tool. */
export function runTask(input: Input, { progress }: TaskContext): Output {
  progress(0, 1);
  let output: Output;
  if (input.unit === 'words') {
    const found = wordParts(
      input.before,
      input.after,
      input.ignoreWhitespace,
      input.budgetMs ?? TIME_BUDGET_MS,
    );
    const segments: Segment[] = found ?? [
      ...(input.before === '' ? [] : [{ text: input.before, kind: 'removed' as const }]),
      ...(input.after === '' ? [] : [{ text: input.after, kind: 'added' as const }]),
    ];
    output = { unit: 'words', segments, stats: wordsOf(segments), degraded: found === undefined };
  } else {
    const { rows, stats, degraded } = lineRows(input);
    const folded = fold(rows, input.context);
    output = {
      unit: 'lines',
      rows: folded.slice(0, MAX_ROWS),
      stats,
      truncated: folded.length > MAX_ROWS,
      degraded,
    };
  }
  progress(1, 1);
  return output;
}
