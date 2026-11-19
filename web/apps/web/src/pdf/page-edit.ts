import type { OutputSpec } from './types.ts';

/** A page of the document being edited. */
export interface EditPage {
  /** Zero-based page number in the file; never changes, so it identifies the page. */
  readonly id: number;
  /** The turn added on top of the page's own rotation (0, 90, 180, 270). */
  readonly turn: number;
}

export type Pages = readonly EditPage[];

/** The document as it is in the file: every page, in order, not turned. */
export function initialPages(pageCount: number): Pages {
  return Array.from({ length: pageCount }, (_, id) => ({ id, turn: 0 }));
}

/** Adds `degrees` (any multiple of 90, also negative) to a turn and keeps it in 0..270. */
export function addTurn(turn: number, degrees: number): number {
  return (((turn + degrees) % 360) + 360) % 360;
}

/** Turns the pages in `ids` by `degrees`. */
export function rotate(pages: Pages, ids: ReadonlySet<number>, degrees: number): Pages {
  return pages.map((page) =>
    ids.has(page.id) ? { id: page.id, turn: addTurn(page.turn, degrees) } : page,
  );
}

/** Removes the pages in `ids`. */
export function remove(pages: Pages, ids: ReadonlySet<number>): Pages {
  return pages.filter((page) => !ids.has(page.id));
}

/**
 * Moves the pages in `ids` one place earlier (`-1`) or later (`1`), keeping their order among
 * themselves. A block of selected pages that already touches the edge stays where it is.
 */
export function shift(pages: Pages, ids: ReadonlySet<number>, direction: -1 | 1): Pages {
  const result = [...pages];
  const last = result.length - 1;
  for (let step = 0; step <= last; step += 1) {
    const index = direction === -1 ? step : last - step;
    const neighbour = index + direction;
    const page = result[index];
    const other = result[neighbour];
    if (page !== undefined && other !== undefined && ids.has(page.id) && !ids.has(other.id)) {
      result[index] = other;
      result[neighbour] = page;
    }
  }
  return result;
}

/**
 * Takes the pages in `ids` out and puts them back as one block so that the first of them lands on
 * `position` (one-based, counted among the pages that stay; too large means the end).
 */
export function moveTo(pages: Pages, ids: ReadonlySet<number>, position: number): Pages {
  const moving = pages.filter((page) => ids.has(page.id));
  const staying = pages.filter((page) => !ids.has(page.id));
  const at = Math.min(Math.max(Math.trunc(position) - 1, 0), staying.length);
  return [...staying.slice(0, at), ...moving, ...staying.slice(at)];
}

/** Moves the page at `from` so that it ends up at `to` (zero-based positions); for drag and drop. */
export function moveIndex(pages: Pages, from: number, to: number): Pages {
  const page = pages[from];
  if (page === undefined || from === to || to < 0 || to >= pages.length) {
    return pages;
  }
  const result = [...pages];
  result.splice(from, 1);
  result.splice(to, 0, page);
  return result;
}

/** The PDF this list of pages describes, made of the pages of source 0. */
export function toOutput(name: string, pages: Pages): OutputSpec {
  return {
    name,
    parts: [{ source: 0, pages: pages.map((page) => ({ index: page.id, turn: page.turn })) }],
  };
}

/** Whether the list differs from the untouched document (a different order, a turn, a deletion). */
export function isChanged(pages: Pages, pageCount: number): boolean {
  return (
    pages.length !== pageCount || pages.some((page, index) => page.id !== index || page.turn !== 0)
  );
}
