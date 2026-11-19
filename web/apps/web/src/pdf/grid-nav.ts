/** Keyboard navigation of the page grid (listbox pattern with rows and columns). */

export type NavKey =
  'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

const NAV_KEYS: readonly string[] = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.includes(key);
}

/** How the Alt+arrow keys move a page: by one place, or by one row. */
export function moveStep(key: string, columns: number): number | undefined {
  switch (key) {
    case 'ArrowLeft':
      return -1;
    case 'ArrowRight':
      return 1;
    case 'ArrowUp':
      return -columns;
    case 'ArrowDown':
      return columns;
    default:
      return undefined;
  }
}

/**
 * Where the focus goes from `index` on `key` in a grid of `count` items with `columns` columns;
 * stays inside the grid. Up and down by a row do nothing when there is no row to go to, Page
 * up and down jump by five rows.
 */
export function nextIndex(key: NavKey, index: number, count: number, columns: number): number {
  if (count <= 0) {
    return 0;
  }
  const last = count - 1;
  const clamp = (value: number): number => Math.min(Math.max(value, 0), last);
  switch (key) {
    case 'ArrowLeft':
      return clamp(index - 1);
    case 'ArrowRight':
      return clamp(index + 1);
    case 'ArrowUp':
      return index - columns < 0 ? index : index - columns;
    case 'ArrowDown':
      return index + columns > last ? index : index + columns;
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageUp':
      return clamp(index - columns * 5);
    case 'PageDown':
      return clamp(index + columns * 5);
  }
}

/** The indices from `a` to `b`, either way round, both included. */
export function between(a: number, b: number): number[] {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

/** `selected` with `id` added, or removed when it was in. */
export function toggled(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

/** The ids of the pages at the positions from `a` to `b` (either way round). */
export function idsBetween(
  pages: readonly { readonly id: number }[],
  a: number,
  b: number,
): Set<number> {
  const ids = new Set<number>();
  for (const position of between(a, b)) {
    const page = pages[position];
    if (page !== undefined) {
      ids.add(page.id);
    }
  }
  return ids;
}

/** The ids of all pages; the empty set. */
export function allIds(pages: readonly { readonly id: number }[]): Set<number> {
  return new Set(pages.map((page) => page.id));
}

export function noIds(): Set<number> {
  return new Set<number>();
}

/** How many items share the first row, given the vertical offset of each item (at least 1). */
export function columnsOf(tops: readonly number[]): number {
  return Math.max(1, tops.filter((top) => top === tops[0]).length);
}

/** `selected` with the page at `position` toggled; unchanged (as a copy) when there is no such page. */
export function toggledAt(
  selected: ReadonlySet<number>,
  pages: readonly { readonly id: number }[],
  position: number,
): Set<number> {
  const page = pages[position];
  return page === undefined ? new Set(selected) : toggled(selected, page.id);
}
