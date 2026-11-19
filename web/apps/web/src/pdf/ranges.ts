import { MAX_OUTPUT_FILES } from './limits.ts';

/** Pages `from` to `to`, both one-based and included. */
export interface PageRange {
  readonly from: number;
  readonly to: number;
}

export type RangeProblem =
  | { readonly code: 'empty' }
  /** `text` is the piece that is not a page or a range. */
  | { readonly code: 'syntax'; readonly text: string }
  /** A range that runs backwards, such as `5-2`. */
  | { readonly code: 'reversed'; readonly text: string }
  /** Page 0, or a page the document does not have. */
  | { readonly code: 'outside'; readonly page: number; readonly total: number }
  | { readonly code: 'too-many'; readonly max: number };

export type RangeResult =
  | { readonly ok: true; readonly ranges: readonly PageRange[] }
  | { readonly ok: false; readonly problem: RangeProblem };

/** Pages are written with ASCII digits; every dash the visitor may type counts as one. */
const DASHES = /[‐-―−]/g;

const ITEM = /^(\d{1,9})(?:\s*-\s*(\d{0,9}))?$/;

/**
 * Reads `1-3, 5, 8-` for a document of `total` pages: items are separated by commas or
 * semicolons, `8-` runs to the last page, every item is its own range (they may overlap).
 */
export function parseRanges(text: string, total: number): RangeResult {
  const items = text
    .replace(DASHES, '-')
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) {
    return { ok: false, problem: { code: 'empty' } };
  }
  if (items.length > MAX_OUTPUT_FILES) {
    return { ok: false, problem: { code: 'too-many', max: MAX_OUTPUT_FILES } };
  }
  const ranges: PageRange[] = [];
  for (const item of items) {
    const match = ITEM.exec(item);
    if (match === null) {
      return { ok: false, problem: { code: 'syntax', text: item } };
    }
    const from = Number(match[1]);
    const rest = match[2];
    const dash = item.includes('-');
    const to = !dash ? from : rest === undefined || rest === '' ? total : Number(rest);
    for (const page of [from, to]) {
      if (page < 1 || page > total) {
        return { ok: false, problem: { code: 'outside', page, total } };
      }
    }
    if (to < from) {
      return { ok: false, problem: { code: 'reversed', text: item } };
    }
    ranges.push({ from, to });
  }
  return { ok: true, ranges };
}

/** Consecutive blocks of `size` pages; the last one may be shorter. */
export function everyN(total: number, size: number): RangeResult {
  if (!Number.isInteger(size) || size < 1 || size > total) {
    return { ok: false, problem: { code: 'outside', page: size, total } };
  }
  const count = Math.ceil(total / size);
  if (count > MAX_OUTPUT_FILES) {
    return { ok: false, problem: { code: 'too-many', max: MAX_OUTPUT_FILES } };
  }
  const ranges: PageRange[] = [];
  for (let from = 1; from <= total; from += size) {
    ranges.push({ from, to: Math.min(from + size - 1, total) });
  }
  return { ok: true, ranges };
}

/** Zero-based page indices of a range, in order. */
export function rangeIndices(range: PageRange): number[] {
  return Array.from({ length: range.to - range.from + 1 }, (_, offset) => range.from - 1 + offset);
}
