import type { PageRange } from './ranges.ts';

const MAX_BASE_LENGTH = 80;

/** Characters no file system takes in a name (and the control characters). */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * The name of an uploaded file without its `.pdf`, safe to use inside a new name: no path
 * pieces, no characters a file system refuses, not empty, not endless.
 */
export function baseName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.pdf$/i, '');
  const cleaned = Array.from(withoutExtension.replace(UNSAFE, '_').trim())
    .slice(0, MAX_BASE_LENGTH)
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return cleaned === '' ? 'document' : cleaned;
}

/** `report_pages-3-5.pdf` or `report_page-4.pdf`. */
export function rangeName(base: string, range: PageRange): string {
  return range.from === range.to
    ? `${base}_page-${String(range.from)}.pdf`
    : `${base}_pages-${String(range.from)}-${String(range.to)}.pdf`;
}

/** `report_part-03.pdf` of `count` parts: the number is padded so the names sort. */
export function partName(base: string, part: number, count: number): string {
  const width = String(count).length;
  return `${base}_part-${String(part).padStart(width, '0')}.pdf`;
}

/** Makes every name unique by numbering repeats (`a.pdf`, `a-2.pdf`, `a-3.pdf`), case-insensitively. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const stem = name.replace(/\.pdf$/i, '');
    let candidate = name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n += 1) {
      candidate = `${stem}-${String(n)}.pdf`;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}
