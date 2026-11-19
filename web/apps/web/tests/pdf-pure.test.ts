import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/pdf/crc32.ts';
import { formatBytes } from '../src/pdf/format.ts';
import {
  canRedo,
  canUndo,
  commit,
  MAX_HISTORY,
  redo,
  startHistory,
  undo,
} from '../src/pdf/history.ts';
import { fitsInputLimit, MAX_OUTPUT_FILES, MAX_TOTAL_INPUT_BYTES } from '../src/pdf/limits.ts';
import { baseName, partName, rangeName, uniqueNames } from '../src/pdf/names.ts';
import {
  addTurn,
  initialPages,
  isChanged,
  moveIndex,
  moveTo,
  remove,
  rotate,
  shift,
  toOutput,
  type Pages,
} from '../src/pdf/page-edit.ts';
import { everyN, parseRanges, rangeIndices } from '../src/pdf/ranges.ts';
import { buildZip, dosDateTime, ZipLimitError } from '../src/pdf/zip.ts';

const ids = (pages: Pages): number[] => pages.map((page) => page.id);

describe('crc32', () => {
  it('matches the published check values', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43);
  });

  it('can continue from an earlier value', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4)))).toBe(0xcbf43926);
  });
});

describe('limits', () => {
  it('accepts the limit and refuses one byte more', () => {
    expect(fitsInputLimit(MAX_TOTAL_INPUT_BYTES)).toBe(true);
    expect(fitsInputLimit(MAX_TOTAL_INPUT_BYTES + 1)).toBe(false);
    expect(fitsInputLimit(0)).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, 'en', '0B'],
    [1023, 'en', '1,023B'],
    [1024, 'en', '1kB'],
    [1536, 'en', '1.5kB'],
    [1024 ** 2, 'en', '1MB'],
    [100 * 1024 ** 2, 'en', '100MB'],
    [1024 ** 3, 'en', '1GB'],
    [1536 * 1024, 'de', '1,5 MB'],
  ])('writes %d bytes in %s', (bytes, locale, expected) => {
    expect(formatBytes(bytes, locale).replace(/\s/g, '')).toBe(expected.replace(/\s/g, ''));
  });
});

describe('parseRanges', () => {
  it('reads pages, ranges and open ranges', () => {
    expect(parseRanges('1-3, 5, 8-', 10)).toEqual({
      ok: true,
      ranges: [
        { from: 1, to: 3 },
        { from: 5, to: 5 },
        { from: 8, to: 10 },
      ],
    });
  });

  it('accepts semicolons, spaces around dashes and typographic dashes', () => {
    expect(parseRanges('2 - 4; 6–8; 9', 9)).toEqual({
      ok: true,
      ranges: [
        { from: 2, to: 4 },
        { from: 6, to: 8 },
        { from: 9, to: 9 },
      ],
    });
  });

  it('accepts the first and the last page and ranges that overlap', () => {
    expect(parseRanges('1, 5, 1-5, 3-4', 5)).toEqual({
      ok: true,
      ranges: [
        { from: 1, to: 1 },
        { from: 5, to: 5 },
        { from: 1, to: 5 },
        { from: 3, to: 4 },
      ],
    });
  });

  it.each(['', ' ', ',', ' , ; '])('says "empty" for %j', (text) => {
    expect(parseRanges(text, 5)).toEqual({ ok: false, problem: { code: 'empty' } });
  });

  it.each(['a', '1-b', '1--3', '-3', '1.5', '1 2', '1-2-3', '0x1', '1e1'])(
    'says "syntax" for %j',
    (text) => {
      expect(parseRanges(text, 5)).toEqual({
        ok: false,
        problem: { code: 'syntax', text: text.trim() },
      });
    },
  );

  it('says "outside" one page past either end', () => {
    expect(parseRanges('6', 5)).toEqual({
      ok: false,
      problem: { code: 'outside', page: 6, total: 5 },
    });
    expect(parseRanges('0', 5)).toEqual({
      ok: false,
      problem: { code: 'outside', page: 0, total: 5 },
    });
    expect(parseRanges('3-6', 5)).toEqual({
      ok: false,
      problem: { code: 'outside', page: 6, total: 5 },
    });
    expect(parseRanges('0-3', 5)).toEqual({
      ok: false,
      problem: { code: 'outside', page: 0, total: 5 },
    });
    expect(parseRanges('5', 5).ok).toBe(true);
    expect(parseRanges('1', 5).ok).toBe(true);
  });

  it('says "reversed" for a range that runs backwards, but not for a single page range', () => {
    expect(parseRanges('4-2', 5)).toEqual({
      ok: false,
      problem: { code: 'reversed', text: '4-2' },
    });
    expect(parseRanges('3-3', 5)).toEqual({ ok: true, ranges: [{ from: 3, to: 3 }] });
  });

  it('refuses more ranges than files may be made', () => {
    const many = Array.from({ length: MAX_OUTPUT_FILES + 1 }, () => '1').join(',');
    expect(parseRanges(many, 5)).toEqual({
      ok: false,
      problem: { code: 'too-many', max: MAX_OUTPUT_FILES },
    });
    expect(parseRanges(many.slice(0, -2), 5).ok).toBe(true);
  });

  it('reports the first problem in the text', () => {
    expect(parseRanges('x, 99', 5)).toMatchObject({ problem: { code: 'syntax', text: 'x' } });
  });
});

describe('everyN', () => {
  it('cuts blocks of N and a shorter last block', () => {
    expect(everyN(7, 3)).toEqual({
      ok: true,
      ranges: [
        { from: 1, to: 3 },
        { from: 4, to: 6 },
        { from: 7, to: 7 },
      ],
    });
  });

  it('accepts 1 and the page count', () => {
    expect(everyN(3, 1)).toMatchObject({
      ok: true,
      ranges: [
        { from: 1, to: 1 },
        { from: 2, to: 2 },
        { from: 3, to: 3 },
      ],
    });
    expect(everyN(3, 3)).toEqual({ ok: true, ranges: [{ from: 1, to: 3 }] });
  });

  it.each([0, -1, 1.5, Number.NaN, 4])('refuses %s for 3 pages', (size) => {
    expect(everyN(3, size)).toEqual({
      ok: false,
      problem: { code: 'outside', page: size, total: 3 },
    });
  });

  it('refuses a split into more files than may be made, and allows exactly that many', () => {
    expect(everyN(MAX_OUTPUT_FILES + 1, 1)).toEqual({
      ok: false,
      problem: { code: 'too-many', max: MAX_OUTPUT_FILES },
    });
    expect(everyN(MAX_OUTPUT_FILES, 1).ok).toBe(true);
  });

  it('covers every page exactly once for any size (property)', () => {
    for (let total = 1; total <= 40; total += 1) {
      for (let size = 1; size <= total; size += 1) {
        const result = everyN(total, size);
        if (!result.ok) {
          throw new Error('unexpected refusal');
        }
        const pages = result.ranges.flatMap(rangeIndices);
        expect(pages).toEqual(Array.from({ length: total }, (_, index) => index));
        expect(
          result.ranges.slice(0, -1).every((range) => range.to - range.from + 1 === size),
        ).toBe(true);
      }
    }
  });
});

describe('rangeIndices', () => {
  it('lists the zero-based pages of a range', () => {
    expect(rangeIndices({ from: 3, to: 5 })).toEqual([2, 3, 4]);
    expect(rangeIndices({ from: 1, to: 1 })).toEqual([0]);
  });
});

describe('names', () => {
  it('strips .pdf in any case and unsafe characters', () => {
    expect(baseName('Report.PDF')).toBe('Report');
    expect(baseName('a/b\\c:d*e?f"g<h>i|j.pdf')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(baseName('x\u0000y\u001fz\u007f')).toBe('x_y_z_');
    expect(baseName('my.report.pdf')).toBe('my.report');
  });

  it('never returns an empty name, a hidden file or an endless one', () => {
    expect(baseName('.pdf')).toBe('document');
    expect(baseName('   .pdf')).toBe('document');
    expect(baseName('')).toBe('document');
    expect(baseName('..hidden.pdf')).toBe('hidden');
    expect(baseName('a'.repeat(200) + '.pdf')).toHaveLength(80);
    // Characters beyond the BMP count as one.
    expect(Array.from(baseName('\u{1f600}'.repeat(100)))).toHaveLength(80);
  });

  it('names ranges and parts', () => {
    expect(rangeName('r', { from: 2, to: 4 })).toBe('r_pages-2-4.pdf');
    expect(rangeName('r', { from: 5, to: 5 })).toBe('r_page-5.pdf');
    expect(partName('r', 3, 9)).toBe('r_part-3.pdf');
    expect(partName('r', 3, 10)).toBe('r_part-03.pdf');
    expect(partName('r', 10, 120)).toBe('r_part-010.pdf');
  });

  it('numbers repeated names, case-insensitively, keeping the order', () => {
    expect(uniqueNames(['a.pdf', 'b.pdf', 'a.pdf', 'A.PDF', 'a-2.pdf'])).toEqual([
      'a.pdf',
      'b.pdf',
      'a-2.pdf',
      'A-3.pdf',
      'a-2-2.pdf',
    ]);
    expect(uniqueNames([])).toEqual([]);
  });
});

describe('history', () => {
  it('starts without anything to undo or redo', () => {
    const history = startHistory('a', 'start');
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('goes back and forth through the states', () => {
    let history = startHistory('a', 'start');
    history = commit(history, 'b', 'to b');
    history = commit(history, 'c', 'to c');
    expect(history.present).toEqual({ value: 'c', label: 'to c' });
    history = undo(history);
    expect(history.present).toEqual({ value: 'b', label: 'to b' });
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(true);
    history = undo(history);
    expect(history.present.value).toBe('a');
    expect(canUndo(history)).toBe(false);
    history = redo(redo(history));
    expect(history.present.value).toBe('c');
    expect(canRedo(history)).toBe(false);
  });

  it('forgets the redo states when something new is committed', () => {
    let history = commit(startHistory('a', 's'), 'b', 'b');
    history = undo(history);
    history = commit(history, 'x', 'x');
    expect(canRedo(history)).toBe(false);
    expect(history.past.map((entry) => entry.value)).toEqual(['a']);
  });

  it('keeps the newest MAX_HISTORY steps', () => {
    let history = startHistory(0, 'start');
    for (let step = 1; step <= MAX_HISTORY + 5; step += 1) {
      history = commit(history, step, `step ${String(step)}`);
    }
    expect(history.past).toHaveLength(MAX_HISTORY);
    expect(history.past[0]?.value).toBe(5);
    expect(history.present.value).toBe(MAX_HISTORY + 5);
  });
});

describe('page-edit', () => {
  const five = initialPages(5);

  it('starts with every page in place, not turned', () => {
    expect(five.map((page) => [page.id, page.turn])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    expect(isChanged(five, 5)).toBe(false);
    expect(initialPages(0)).toEqual([]);
  });

  it.each([
    [0, 90, 90],
    [270, 90, 0],
    [0, -90, 270],
    [90, -180, 270],
    [0, 360, 0],
    [180, 540, 0],
  ])('adds %i and %i degrees to %i', (turn, degrees, expected) => {
    expect(addTurn(turn, degrees)).toBe(expected);
  });

  it('turns only the chosen pages', () => {
    const turned = rotate(five, new Set([1, 3]), 90);
    expect(turned.map((page) => page.turn)).toEqual([0, 90, 0, 90, 0]);
    expect(rotate(turned, new Set([1]), 270).map((page) => page.turn)).toEqual([0, 0, 0, 90, 0]);
    expect(rotate(five, new Set(), 90)).toEqual(five);
  });

  it('removes the chosen pages and keeps the others in order', () => {
    expect(ids(remove(five, new Set([0, 2, 4])))).toEqual([1, 3]);
    expect(ids(remove(five, new Set()))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(remove(five, new Set([0, 1, 2, 3, 4])))).toEqual([]);
    expect(ids(remove(five, new Set([9])))).toEqual([0, 1, 2, 3, 4]);
  });

  it('moves a selection one place earlier or later', () => {
    expect(ids(shift(five, new Set([2]), -1))).toEqual([0, 2, 1, 3, 4]);
    expect(ids(shift(five, new Set([2]), 1))).toEqual([0, 1, 3, 2, 4]);
    expect(ids(shift(five, new Set([1, 2]), -1))).toEqual([1, 2, 0, 3, 4]);
    expect(ids(shift(five, new Set([1, 3]), 1))).toEqual([0, 2, 1, 4, 3]);
  });

  it('leaves a block that touches the edge where it is', () => {
    expect(ids(shift(five, new Set([0]), -1))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(shift(five, new Set([4]), 1))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(shift(five, new Set([0, 1, 3]), -1))).toEqual([0, 1, 3, 2, 4]);
    expect(ids(shift(five, new Set([0, 1, 2, 3, 4]), 1))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(shift([], new Set([1]), 1))).toEqual([]);
  });

  it('moves a selection to a position', () => {
    expect(ids(moveTo(five, new Set([3, 4]), 1))).toEqual([3, 4, 0, 1, 2]);
    expect(ids(moveTo(five, new Set([0]), 3))).toEqual([1, 2, 0, 3, 4]);
    expect(ids(moveTo(five, new Set([1, 3]), 2))).toEqual([0, 1, 3, 2, 4]);
  });

  it('clamps a position to the start and the end', () => {
    expect(ids(moveTo(five, new Set([2]), 0))).toEqual([2, 0, 1, 3, 4]);
    expect(ids(moveTo(five, new Set([2]), -7))).toEqual([2, 0, 1, 3, 4]);
    expect(ids(moveTo(five, new Set([2]), 99))).toEqual([0, 1, 3, 4, 2]);
    expect(ids(moveTo(five, new Set([2]), 2.9))).toEqual([0, 2, 1, 3, 4]);
    expect(ids(moveTo(five, new Set(), 2))).toEqual([0, 1, 2, 3, 4]);
  });

  it('moves one page from a position to a position', () => {
    expect(ids(moveIndex(five, 0, 3))).toEqual([1, 2, 3, 0, 4]);
    expect(ids(moveIndex(five, 4, 0))).toEqual([4, 0, 1, 2, 3]);
    expect(moveIndex(five, 2, 2)).toBe(five);
    expect(moveIndex(five, 5, 0)).toBe(five);
    expect(moveIndex(five, -1, 0)).toBe(five);
    expect(moveIndex(five, 0, 5)).toBe(five);
    expect(moveIndex(five, 0, -1)).toBe(five);
  });

  it('knows when the document differs from the file', () => {
    expect(isChanged(rotate(five, new Set([2]), 90), 5)).toBe(true);
    expect(isChanged(rotate(rotate(five, new Set([2]), 90), new Set([2]), 270), 5)).toBe(false);
    expect(isChanged(remove(five, new Set([4])), 5)).toBe(true);
    expect(isChanged(shift(five, new Set([1]), 1), 5)).toBe(true);
  });

  it('describes the result as one part of source 0', () => {
    expect(
      toOutput('x.pdf', rotate(shift(five, new Set([4]), -1), new Set([4]), 90)).parts,
    ).toEqual([
      {
        source: 0,
        pages: [
          { index: 0, turn: 0 },
          { index: 1, turn: 0 },
          { index: 2, turn: 0 },
          { index: 4, turn: 90 },
          { index: 3, turn: 0 },
        ],
      },
    ]);
  });

  it('keeps every page exactly once whatever is moved (property)', () => {
    let seed = 7;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    for (let round = 0; round < 300; round += 1) {
      const size = 1 + random(12);
      let pages = initialPages(size);
      for (let step = 0; step < 10; step += 1) {
        const chosen = new Set(pages.filter(() => random(3) === 0).map((page) => page.id));
        const action = random(4);
        pages =
          action === 0
            ? shift(pages, chosen, -1)
            : action === 1
              ? shift(pages, chosen, 1)
              : action === 2
                ? moveTo(pages, chosen, random(size + 2))
                : moveIndex(pages, random(size), random(size));
        expect(ids(pages).toSorted((a, b) => a - b)).toEqual(
          Array.from({ length: size }, (_, id) => id),
        );
      }
    }
  });
});

interface Parsed {
  readonly name: string;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
  readonly flags: number;
  readonly method: number;
}

/** Reads the central directory of a ZIP the way an extractor does. */
async function readZip(blob: Blob): Promise<{ entries: Parsed[]; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  expect(view.getUint32(end + 12, true)).toBe(end - at);
  const entries: Parsed[] = [];
  for (let n = 0; n < count; n += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      crc: view.getUint32(at + 16, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
    });
    at += 46 + nameLength;
  }
  return { entries, bytes };
}

describe('buildZip', () => {
  const entry = (name: string, text: string): Parameters<typeof buildZip>[0][number] => {
    const data = new TextEncoder().encode(text);
    return { name, data, size: data.length, crc32: crc32(data) };
  };

  it('writes entries that an extractor reads back', async () => {
    const zip = buildZip([
      entry('a.pdf', 'first file'),
      entry('b/ü.pdf', 'second'),
      entry('empty.pdf', ''),
    ]);
    expect(zip.type).toBe('application/zip');
    const { entries, bytes } = await readZip(zip);
    expect(entries.map((item) => item.name)).toEqual(['a.pdf', 'b/ü.pdf', 'empty.pdf']);
    const view = new DataView(bytes.buffer);
    for (const [index, text] of ['first file', 'second', ''].entries()) {
      const item = entries[index];
      if (item === undefined) {
        throw new Error('missing entry');
      }
      // The local header at the offset agrees with the central one and the data follows it.
      expect(view.getUint32(item.offset, true)).toBe(0x04034b50);
      expect(view.getUint16(item.offset + 6, true)).toBe(0x0800);
      expect(item.flags).toBe(0x0800);
      expect(item.method).toBe(0);
      const nameLength = view.getUint16(item.offset + 26, true);
      const start = item.offset + 30 + nameLength;
      const data = bytes.subarray(start, start + item.size);
      expect(new TextDecoder().decode(data)).toBe(text);
      expect(crc32(data)).toBe(item.crc);
      expect(view.getUint32(item.offset + 14, true)).toBe(item.crc);
      expect(view.getUint32(item.offset + 18, true)).toBe(item.size);
      expect(view.getUint32(item.offset + 22, true)).toBe(item.size);
    }
  });

  it('takes blobs as data and an empty list as an empty archive', async () => {
    const data = new Blob(['blob data']);
    const zip = buildZip([
      { name: 'x.pdf', data, size: data.size, crc32: crc32(new TextEncoder().encode('blob data')) },
    ]);
    const { entries } = await readZip(zip);
    expect(entries).toHaveLength(1);
    expect(zip.size).toBe(30 + 5 + 9 + 46 + 5 + 22);
    expect(buildZip([]).size).toBe(22);
  });

  it('writes the time as MS-DOS date and time', () => {
    expect(dosDateTime(new Date(2026, 10, 19, 7, 34, 41))).toEqual({
      date: ((2026 - 1980) << 9) | (11 << 5) | 19,
      time: (7 << 11) | (34 << 5) | 20,
    });
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
    expect(dosDateTime(new Date(2200, 0, 1)).date >> 9).toBe(127);
  });

  it('stamps the entries with the given time', async () => {
    const { bytes, entries } = await readZip(
      buildZip([entry('a', 'x')], new Date(2025, 5, 6, 12, 30, 0)),
    );
    const view = new DataView(bytes.buffer);
    const item = entries[0];
    expect(item).toBeDefined();
    expect(view.getUint16((item?.offset ?? 0) + 10, true)).toBe((12 << 11) | (30 << 5));
    expect(view.getUint16((item?.offset ?? 0) + 12, true)).toBe(
      ((2025 - 1980) << 9) | (6 << 5) | 6,
    );
  });

  it('refuses what it cannot write without ZIP64', () => {
    const one = entry('f', '');
    const many = Array.from({ length: 0x10000 }, () => one);
    expect(() => buildZip(many)).toThrow(ZipLimitError);
    expect(() => buildZip(many)).toThrow('65535');
    const huge = { name: 'big', data: new Uint8Array(0), size: 0x1_0000_0000, crc32: 0 };
    expect(() => buildZip([huge])).toThrow(ZipLimitError);
    const nearly = { name: 'big', data: new Uint8Array(0), size: 0xffff_ffff - 100, crc32: 0 };
    expect(() => buildZip([nearly, nearly])).toThrow('4 GiB');
    const fits = 0xffff_ffff - 30 - 3 - 22 - 46 - 3;
    expect(() => buildZip([{ ...nearly, size: fits + 1 }])).toThrow(ZipLimitError);
    expect(buildZip([{ ...nearly, size: fits }]).size).toBeGreaterThan(0);
  });
});
