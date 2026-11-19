import { t } from '../i18n/index.ts';
import { baseName, partName, rangeName, uniqueNames } from './names.ts';
import { everyN, parseRanges, rangeIndices, type PageRange, type RangeProblem } from './ranges.ts';
import type { OutputSpec } from './types.ts';

export type SplitMode = 'ranges' | 'every' | 'selection';

export type SplitPlan =
  | { readonly ok: true; readonly outputs: readonly OutputSpec[] }
  /** `message` is empty while the visitor has not typed or chosen anything yet. */
  | { readonly ok: false; readonly message: string };

/** The sentence for a problem with the page ranges the visitor typed. */
export function problemText(problem: RangeProblem): string {
  switch (problem.code) {
    case 'empty':
      return t('pdf.range.empty');
    case 'syntax':
      return t('pdf.range.syntax', { text: problem.text });
    case 'reversed':
      return t('pdf.range.reversed', { text: problem.text });
    case 'outside':
      return t('pdf.range.outside', { page: problem.page, total: problem.total });
    case 'too-many':
      return t('pdf.range.tooMany', { max: problem.max });
  }
}

function specs(
  names: readonly string[],
  groups: readonly (readonly number[])[],
): readonly OutputSpec[] {
  return names.map((name, at) => ({
    name,
    parts: [
      {
        source: 0,
        pages: (groups[at] ?? []).map((index) => ({ index, turn: 0 })),
      },
    ],
  }));
}

export interface SplitInput {
  readonly mode: SplitMode;
  readonly fileName: string;
  readonly pageCount: number;
  readonly rangesText: string;
  readonly everyText: string;
  /** Zero-based pages chosen in the grid. */
  readonly selected: ReadonlySet<number>;
}

function fromRanges(base: string, ranges: readonly PageRange[], every: boolean): SplitPlan {
  const names = every
    ? ranges.map((_, at) => partName(base, at + 1, ranges.length))
    : ranges.map((range) => rangeName(base, range));
  return { ok: true, outputs: specs(uniqueNames(names), ranges.map(rangeIndices)) };
}

/** What the visitor's choices make: the PDFs to create, or the sentence that says what is wrong. */
export function planSplit(input: SplitInput): SplitPlan {
  const base = baseName(input.fileName);
  if (input.mode === 'selection') {
    if (input.selected.size === 0) {
      return { ok: false, message: '' };
    }
    const pages = [...input.selected].toSorted((a, b) => a - b);
    return { ok: true, outputs: specs([`${base}_selection.pdf`], [pages]) };
  }
  if (input.mode === 'ranges') {
    if (input.rangesText.trim() === '') {
      return { ok: false, message: '' };
    }
    const parsed = parseRanges(input.rangesText, input.pageCount);
    return parsed.ok
      ? fromRanges(base, parsed.ranges, false)
      : { ok: false, message: problemText(parsed.problem) };
  }
  const text = input.everyText.trim();
  if (text === '') {
    return { ok: false, message: '' };
  }
  const size = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
  const parsed = everyN(input.pageCount, size);
  if (parsed.ok) {
    return fromRanges(base, parsed.ranges, true);
  }
  return {
    ok: false,
    message:
      parsed.problem.code === 'too-many'
        ? problemText(parsed.problem)
        : t('pdf.split.everyError', { max: input.pageCount }),
  };
}
