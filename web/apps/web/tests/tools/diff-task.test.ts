import { timeBudget } from '../time-budget.ts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT,
  MAX_INTRA_LINE,
  MAX_ROWS,
  fold,
  leftSide,
  rightSide,
  runTask,
  type Input,
  type Output,
  type Row,
  type Segment,
} from '../../src/tools/diff/task.ts';

const progress = (): void => undefined;

function lines(
  before: string,
  after: string,
  options: Partial<Input> = {},
): Extract<Output, { unit: 'lines' }> {
  const output = runTask(
    { before, after, unit: 'lines', ignoreWhitespace: false, context: -1, ...options },
    { progress },
  );
  if (output.unit !== 'lines') {
    throw new Error('expected the line view');
  }
  return output;
}

function words(
  before: string,
  after: string,
  options: Partial<Input> = {},
): Extract<Output, { unit: 'words' }> {
  const output = runTask(
    { before, after, unit: 'words', ignoreWhitespace: false, context: -1, ...options },
    { progress },
  );
  if (output.unit !== 'words') {
    throw new Error('expected the word view');
  }
  return output;
}

function text(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** The old and the new lines, read back from the rows. */
function readBack(rows: readonly Row[]): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const row of rows) {
    if (row.kind === 'same') {
      before.push(row.text);
      after.push(row.text);
    } else if (row.kind === 'removed') {
      before.push(text(row.left));
    } else if (row.kind === 'added') {
      after.push(text(row.right));
    } else if (row.kind === 'changed') {
      before.push(text(row.left));
      after.push(text(row.right));
    }
  }
  return { before, after };
}

describe('the line view', () => {
  it('shows identical texts as unchanged lines with their numbers', () => {
    const output = lines('a\nb\nc\n', 'a\nb\nc\n');
    expect(output.rows).toEqual([
      { kind: 'same', before: 1, after: 1, text: 'a' },
      { kind: 'same', before: 2, after: 2, text: 'b' },
      { kind: 'same', before: 3, after: 3, text: 'c' },
    ]);
    expect(output.stats).toEqual({ added: 0, removed: 0, unchanged: 3 });
    expect(output.truncated).toBe(false);
    expect(output.degraded).toBe(false);
  });

  it('shows two empty texts as nothing and one empty text as all added or all removed', () => {
    expect(lines('', '').rows).toEqual([]);
    expect(lines('', 'x\ny').rows).toEqual([
      { kind: 'added', after: 1, right: [{ text: 'x', kind: 'added' }] },
      { kind: 'added', after: 2, right: [{ text: 'y', kind: 'added' }] },
    ]);
    expect(lines('x\ny', '').stats).toEqual({ added: 0, removed: 2, unchanged: 0 });
  });

  it('marks an added line and a removed line with the numbers of their own side', () => {
    const output = lines('a\nb\nc', 'a\nc\nd');
    expect(output.rows).toEqual([
      { kind: 'same', before: 1, after: 1, text: 'a' },
      { kind: 'removed', before: 2, left: [{ text: 'b', kind: 'removed' }] },
      { kind: 'same', before: 3, after: 2, text: 'c' },
      { kind: 'added', after: 3, right: [{ text: 'd', kind: 'added' }] },
    ]);
    expect(output.stats).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it('pairs a removed line with the added line after it and marks the words that differ', () => {
    const output = lines('the quick brown fox\n', 'the quick red fox\n');
    expect(output.rows).toEqual([
      {
        kind: 'changed',
        before: 1,
        after: 1,
        left: [
          { text: 'the quick ', kind: 'same' },
          { text: 'brown', kind: 'removed' },
          { text: ' fox', kind: 'same' },
        ],
        right: [
          { text: 'the quick ', kind: 'same' },
          { text: 'red', kind: 'added' },
          { text: ' fox', kind: 'same' },
        ],
      },
    ]);
    expect(output.stats).toEqual({ added: 1, removed: 1, unchanged: 0 });
  });

  it('pairs as many lines as both sides have and shows the rest as removed or added', () => {
    const more = lines('one\ntwo\nthree', 'uno');
    expect(more.rows.map((row) => row.kind)).toEqual(['changed', 'removed', 'removed']);
    const fewer = lines('one', 'uno\ndos\ntres');
    expect(fewer.rows.map((row) => row.kind)).toEqual(['changed', 'added', 'added']);
    expect(fewer.stats).toEqual({ added: 3, removed: 1, unchanged: 0 });
  });

  it('treats a line break style and a missing final line break as no difference', () => {
    expect(lines('a\r\nb\r\n', 'a\nb\n').stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(lines('a\nb', 'a\nb\n').stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(lines('a\nb\n', 'a\nb').stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
  });

  it('keeps white space differences unless asked to ignore them', () => {
    const strict = lines('a  b\n  c\n', 'a b\nc\n');
    expect(strict.stats).toEqual({ added: 2, removed: 2, unchanged: 0 });
    const loose = lines('a  b\n  c\n', 'a b\nc\n', { ignoreWhitespace: true });
    expect(loose.stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(loose.rows.every((row) => row.kind === 'same')).toBe(true);
  });

  it('ignores white space inside a changed line pair too', () => {
    const output = lines('x = 1  + 2\n', 'x = 1 + 3\n', { ignoreWhitespace: true });
    const row = output.rows[0];
    expect(row?.kind).toBe('changed');
    if (row?.kind === 'changed') {
      expect(row.left.filter((segment) => segment.kind === 'removed').map((s) => s.text)).toEqual([
        '2',
      ]);
      expect(row.right.filter((segment) => segment.kind === 'added').map((s) => s.text)).toEqual([
        '3',
      ]);
    }
  });

  it('shows a very long changed line as one removed and one added piece', () => {
    const long = 'word '.repeat(MAX_INTRA_LINE / 4);
    const output = lines(`${long}a\n`, `${long}b\n`);
    const row = output.rows[0];
    expect(row?.kind).toBe('changed');
    if (row?.kind === 'changed') {
      expect(row.left).toEqual([{ text: `${long}a`, kind: 'removed' }]);
      expect(row.right).toEqual([{ text: `${long}b`, kind: 'added' }]);
    }
    const short = lines(`${'w '.repeat(100)}a\n`, `${'w '.repeat(100)}b\n`);
    expect(short.rows[0]?.kind === 'changed' && short.rows[0].left.length).toBeGreaterThan(1);
  });

  it('reads back to both texts, for random edits (a property test with a seeded generator)', () => {
    let state = 99;
    const next = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 4_294_967_296) * limit);
    };
    const vocabulary = ['alpha', 'beta', 'gamma beta', '', '  indented', 'delta;', 'α β'];
    for (let round = 0; round < 150; round += 1) {
      const before = Array.from(
        { length: next(30) },
        () => vocabulary[next(vocabulary.length)] ?? '',
      );
      const after = before
        .filter(() => next(5) !== 0)
        .flatMap((line) =>
          next(6) === 0 ? [line, vocabulary[next(vocabulary.length)] ?? ''] : [line],
        );
      const output = lines(before.join('\n'), after.join('\n'));
      const back = readBack(output.rows);
      // A text without a final line break and a trailing empty line are the same to the diff.
      const trim = (list: string[]): string[] => {
        const copy = [...list];
        while (copy[copy.length - 1] === '') {
          copy.pop();
        }
        return copy;
      };
      expect(trim(back.before)).toEqual(trim(before));
      expect(trim(back.after)).toEqual(trim(after));
      const { added, removed, unchanged } = output.stats;
      expect(unchanged + removed).toBe(back.before.length);
      expect(unchanged + added).toBe(back.after.length);
    }
  });
});

describe('folding unchanged lines', () => {
  const numbered = (count: number): string =>
    Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`).join('\n');

  it('keeps `context` lines around a change and says how many it left out', () => {
    const before = numbered(20);
    const after = before.replace('line 10', 'line ten');
    const output = lines(before, after, { context: 2 });
    expect(output.rows.map((row) => row.kind)).toEqual([
      'skipped',
      'same',
      'same',
      'changed',
      'same',
      'same',
      'skipped',
    ]);
    expect(output.rows[0]).toEqual({ kind: 'skipped', count: 7 });
    expect(output.rows[6]).toEqual({ kind: 'skipped', count: 8 });
    expect(output.stats.unchanged).toBe(19);
  });

  it('keeps everything when the context is -1 and only the change when it is 0', () => {
    const before = numbered(10);
    const after = before.replace('line 5', 'line five');
    expect(lines(before, after, { context: -1 }).rows).toHaveLength(10);
    const none = lines(before, after, { context: 0 });
    expect(none.rows.map((row) => row.kind)).toEqual(['skipped', 'changed', 'skipped']);
    expect(none.rows[0]).toEqual({ kind: 'skipped', count: 4 });
  });

  it('keeps a single line instead of a "1 line skipped" row, and folds two', () => {
    const rows: Row[] = [
      { kind: 'added', after: 1, right: [] },
      { kind: 'same', before: 1, after: 2, text: 'x' },
      { kind: 'same', before: 2, after: 3, text: 'y' },
      { kind: 'same', before: 3, after: 4, text: 'z' },
      { kind: 'added', after: 5, right: [] },
    ];
    expect(fold(rows, 0).map((row) => row.kind)).toEqual(['added', 'skipped', 'added']);
    expect(fold(rows.slice(0, 3), 0).map((row) => row.kind)).toEqual(['added', 'skipped']);
    const single = [rows[0], rows[1], rows[4]].filter((row): row is Row => row !== undefined);
    expect(fold(single, 0).map((row) => row.kind)).toEqual(['added', 'same', 'added']);
  });

  it('shows no rows folded for identical texts only as one skipped row', () => {
    const output = lines(numbered(50), numbered(50), { context: DEFAULT_CONTEXT });
    expect(output.rows).toEqual([{ kind: 'skipped', count: 50 }]);
    expect(lines('', '', { context: 3 }).rows).toEqual([]);
    expect(fold([], 3)).toEqual([]);
  });

  it('folds nothing across a change on both ends', () => {
    const before = numbered(6);
    const after = before.replace('line 1', 'one').replace('line 6', 'six');
    const output = lines(before, after, { context: 1 });
    expect(output.rows.map((row) => row.kind)).toEqual([
      'changed',
      'same',
      'skipped',
      'same',
      'changed',
    ]);
    expect(output.rows[2]).toEqual({ kind: 'skipped', count: 2 });
  });
});

describe('the number of rows', () => {
  it('cuts the rows at the limit and says so', () => {
    const many = Array.from({ length: MAX_ROWS + 50 }, (_, index) => `new ${String(index)}`).join(
      '\n',
    );
    const output = lines('', many);
    expect(output.rows).toHaveLength(MAX_ROWS);
    expect(output.truncated).toBe(true);
    expect(output.stats.added).toBe(MAX_ROWS + 50);
    const exact = lines(
      '',
      Array.from({ length: MAX_ROWS }, (_, index) => `n${String(index)}`).join('\n'),
    );
    expect(exact.rows).toHaveLength(MAX_ROWS);
    expect(exact.truncated).toBe(false);
  });
});

describe('the word view', () => {
  it('marks the words that were removed and added, and counts them', () => {
    const output = words('the quick brown fox', 'the slow brown dog');
    expect(output.segments).toEqual([
      { text: 'the ', kind: 'same' },
      { text: 'quick', kind: 'removed' },
      { text: 'slow', kind: 'added' },
      { text: ' brown ', kind: 'same' },
      { text: 'fox', kind: 'removed' },
      { text: 'dog', kind: 'added' },
    ]);
    expect(output.stats).toEqual({ added: 2, removed: 2, unchanged: 2 });
    expect(output.degraded).toBe(false);
    expect(text(leftSide(output.segments))).toBe('the quick brown fox');
    expect(text(rightSide(output.segments))).toBe('the slow brown dog');
  });

  it('counts a space difference only when white space matters', () => {
    expect(words('a  b', 'a b').segments.some((segment) => segment.kind !== 'same')).toBe(true);
    expect(words('a  b', 'a b', { ignoreWhitespace: true }).stats).toEqual({
      added: 0,
      removed: 0,
      unchanged: 2,
    });
  });

  it('handles an empty side', () => {
    expect(words('', 'new text').segments).toEqual([{ text: 'new text', kind: 'added' }]);
    expect(words('old text', '').segments).toEqual([{ text: 'old text', kind: 'removed' }]);
    expect(words('', '').segments).toEqual([]);
  });

  it('reads back to both texts, for random edits', () => {
    let state = 7;
    const next = (limit: number): number => {
      state = (Math.imul(state, 22695477) + 1) >>> 0;
      return Math.floor((state / 4_294_967_296) * limit);
    };
    const vocabulary = ['foo', 'bar', 'baz', 'qux', 'a.', 'b,', 'ünï', '日本'];
    for (let round = 0; round < 100; round += 1) {
      const before = Array.from(
        { length: next(40) },
        () => vocabulary[next(vocabulary.length)] ?? '',
      );
      const after = before.filter(() => next(4) !== 0).concat(next(2) === 0 ? ['new'] : []);
      const output = words(before.join(' '), after.join(' '));
      expect(text(leftSide(output.segments))).toBe(before.join(' '));
      expect(text(rightSide(output.segments))).toBe(after.join(' '));
    }
  });
});

describe('large and very different texts', () => {
  function make(count: number, seed: number): string {
    let state = seed;
    const out: string[] = [];
    for (let index = 0; index < count; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out.push(
        `line ${String(index)} ${state.toString(36)} lorem ipsum dolor sit amet consectetur`,
      );
    }
    return out.join('\n');
  }

  it('compares two texts of 1 MB with a hundred edits in a fraction of a second', () => {
    const before = make(20_000, 1);
    expect(before.length).toBeGreaterThan(1_000_000);
    const after = before
      .split('\n')
      .map((line, index) => (index % 200 === 0 ? `${line} changed` : line))
      .join('\n');
    const started = performance.now();
    const output = lines(before, after, { context: 3 });
    const took = performance.now() - started;
    expect(output.stats).toEqual({ added: 100, removed: 100, unchanged: 19_900 });
    expect(output.degraded).toBe(false);
    expect(took).toBeLessThan(timeBudget(3000));
    const inWords = words(before, after);
    expect(inWords.stats.added).toBe(100);
    expect(inWords.degraded).toBe(false);
  });

  it('shows two texts that share nothing as replaced once the time budget is used up', () => {
    const before = make(4000, 1);
    const after = make(4000, 2);
    const started = performance.now();
    const output = lines(before, after, { budgetMs: 30, context: 3 });
    expect(performance.now() - started).toBeLessThan(timeBudget(2000));
    expect(output.degraded).toBe(true);
    expect(output.stats).toEqual({ added: 4000, removed: 4000, unchanged: 0 });
    expect(output.rows.every((row) => row.kind === 'changed')).toBe(true);
    const inWords = words(before, after, { budgetMs: 30 });
    expect(inWords.degraded).toBe(true);
    expect(inWords.segments).toEqual([
      { text: before, kind: 'removed' },
      { text: after, kind: 'added' },
    ]);
  });

  it('shows a replaced text with one empty side without a phantom part', () => {
    const big = make(3000, 3);
    expect(lines('', big, { budgetMs: 1 }).degraded).toBe(false);
    expect(words('', big, { budgetMs: 1 }).segments).toEqual([{ text: big, kind: 'added' }]);
  });
});
