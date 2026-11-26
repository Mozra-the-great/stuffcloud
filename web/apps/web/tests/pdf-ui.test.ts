import { fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../src/i18n/index.ts';
import { release, toResult } from '../src/pdf/download.ts';
import { failureText, isAbort, issueText } from '../src/pdf/issues.ts';
import LiveStatus from '../src/pdf/LiveStatus.svelte';
import { describeAction, pageName, parsePosition } from '../src/pdf/page-actions.ts';
import PageGrid from '../src/pdf/PageGrid.svelte';
import PageThumb from '../src/pdf/PageThumb.svelte';
import { planSplit, problemText } from '../src/pdf/split-plan.ts';
import { drawThumb } from '../src/pdf/thumb-draw.ts';
import type { ThumbnailStore } from '../src/pdf/thumbs.svelte.ts';
import type { PdfIssue } from '../src/pdf/types.ts';
import { dragEvent } from './helpers.ts';
import { fakeBitmap, stubCanvas, stubObjectUrls, at } from './pdf-helpers.ts';

/** The properties of a drag event that the lists read (jsdom has no `DragEvent` or `DataTransfer`). */
function drag(): {
  dataTransfer: { setData: () => void; effectAllowed: string; dropEffect: string };
} {
  return { dataTransfer: { setData: (): void => undefined, effectAllowed: '', dropEffect: '' } };
}

beforeEach(() => {
  i18n.setLocale('en');
});

describe('page actions and split plans', () => {
  it('describes steps in the current language', () => {
    expect(describeAction({ key: 'pdf.pages.did.deleted', count: 1 })).toBe('Deleted 1 page.');
    expect(describeAction({ key: 'pdf.pages.did.deleted', count: 3 })).toBe('Deleted 3 pages.');
    expect(describeAction({ key: 'pdf.pages.did.movedTo', count: 2, position: 5 })).toBe(
      'Moved 2 pages to position 5.',
    );
    i18n.setLocale('de');
    expect(describeAction({ key: 'pdf.pages.did.deleted', count: 3 })).toBe('3 Seiten gelöscht.');
    expect(pageName({ id: 4, turn: 0 }, 2)).toBe('Position 2: Seite 5');
    expect(pageName({ id: 4, turn: 90 }, 2)).toBe(
      'Position 2: Seite 5, 90 Grad im Uhrzeigersinn gedreht',
    );
  });

  it('names a page by its position, its page and its turn', () => {
    expect(pageName({ id: 0, turn: 0 }, 1)).toBe('Position 1: page 1');
    expect(pageName({ id: 6, turn: 270 }, 3)).toBe(
      'Position 3: page 7, turned 270 degrees clockwise',
    );
  });

  it.each([
    ['1', 5, 1],
    ['5', 5, 5],
    [' 3 ', 5, 3],
    ['0', 5, undefined],
    ['6', 5, undefined],
    ['-1', 5, undefined],
    ['1.5', 5, undefined],
    ['', 5, undefined],
    ['a', 5, undefined],
    ['1234567890', 5, undefined],
  ])('reads the position %j of %i pages as %s', (text, max, expected) => {
    expect(parsePosition(text, max)).toBe(expected);
  });

  const base = {
    mode: 'ranges' as const,
    fileName: 'My Book.pdf',
    pageCount: 10,
    rangesText: '',
    everyText: '',
    selected: new Set<number>(),
  };

  it('plans ranges into named files, numbering names that repeat', () => {
    const plan = planSplit({ ...base, rangesText: '1-3, 5, 1-3' });
    expect(plan).toEqual({
      ok: true,
      outputs: [
        {
          name: 'My Book_pages-1-3.pdf',
          parts: [{ source: 0, pages: [0, 1, 2].map((index) => ({ index, turn: 0 })) }],
        },
        { name: 'My Book_page-5.pdf', parts: [{ source: 0, pages: [{ index: 4, turn: 0 }] }] },
        {
          name: 'My Book_pages-1-3-2.pdf',
          parts: [{ source: 0, pages: [0, 1, 2].map((index) => ({ index, turn: 0 })) }],
        },
      ],
    });
  });

  it('plans every N pages with numbered parts', () => {
    const plan = planSplit({ ...base, mode: 'every', everyText: '4' });
    expect(plan.ok && plan.outputs.map((output) => output.name)).toEqual([
      'My Book_part-1.pdf',
      'My Book_part-2.pdf',
      'My Book_part-3.pdf',
    ]);
    expect(plan.ok && plan.outputs[2]?.parts[0]?.pages).toEqual([
      { index: 8, turn: 0 },
      { index: 9, turn: 0 },
    ]);
  });

  it('plans the selection as one file, pages in order', () => {
    const plan = planSplit({ ...base, mode: 'selection', selected: new Set([7, 2, 5]) });
    expect(plan.ok && plan.outputs).toEqual([
      {
        name: 'My Book_selection.pdf',
        parts: [{ source: 0, pages: [2, 5, 7].map((index) => ({ index, turn: 0 })) }],
      },
    ]);
  });

  it('says nothing while nothing is chosen, and what is wrong afterwards', () => {
    expect(planSplit(base)).toEqual({ ok: false, message: '' });
    expect(planSplit({ ...base, rangesText: '  ' })).toEqual({ ok: false, message: '' });
    expect(planSplit({ ...base, mode: 'every' })).toEqual({ ok: false, message: '' });
    expect(planSplit({ ...base, mode: 'selection' })).toEqual({ ok: false, message: '' });
    expect(planSplit({ ...base, rangesText: '11' })).toEqual({
      ok: false,
      message: 'Page 11 does not exist: this PDF has 10 pages.',
    });
    expect(planSplit({ ...base, mode: 'every', everyText: '0' })).toEqual({
      ok: false,
      message: 'Enter a whole number from 1 to 10.',
    });
    expect(planSplit({ ...base, mode: 'every', everyText: 'x' })).toEqual({
      ok: false,
      message: 'Enter a whole number from 1 to 10.',
    });
    expect(planSplit({ ...base, mode: 'every', everyText: '11' })).toMatchObject({ ok: false });
  });

  it('refuses a split into more files than may be made', () => {
    expect(planSplit({ ...base, mode: 'every', everyText: '1', pageCount: 1001 })).toEqual({
      ok: false,
      message: 'That would make more than 1,000 files.',
    });
  });

  it('has a sentence for every kind of range problem', () => {
    expect(problemText({ code: 'empty' })).toBe('Enter at least one page or range.');
    expect(problemText({ code: 'syntax', text: 'x' })).toBe('“x” is not a page or a range.');
    expect(problemText({ code: 'reversed', text: '4-2' })).toBe(
      '“4-2” runs backwards: write the smaller page first.',
    );
    expect(problemText({ code: 'outside', page: 9, total: 3 })).toBe(
      'Page 9 does not exist: this PDF has 3 pages.',
    );
    expect(problemText({ code: 'too-many', max: 5 })).toBe('That would make more than 5 files.');
  });
});

describe('issues', () => {
  it.each<[PdfIssue, string]>([
    [
      'encrypted',
      'a.pdf is protected with a password or encrypted. Remove the protection first, then try again.',
    ],
    ['broken', 'a.pdf could not be read: it is damaged or not a PDF.'],
    ['empty', 'a.pdf has no pages.'],
    [
      'too-large',
      'a.pdf is too large to work on in this browser tab. The limit is 400MB of files and 10,000 pages at a time.',
    ],
    [
      'out-of-memory',
      'The browser ran out of memory while working on a.pdf. Close other tabs or use a smaller file.',
    ],
  ])('says what is wrong with a file that is %s', (issue, text) => {
    expect(issueText(issue, 'a.pdf').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('has a sentence for a worker that failed and recognises an abort', () => {
    expect(failureText()).toContain('Nothing was uploaded');
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
    expect(isAbort('AbortError')).toBe(false);
  });
});

describe('results', () => {
  it('makes a link per file and gives the memory back', () => {
    const { created, revoked } = stubObjectUrls();
    const bytes = new Uint8Array([1, 2, 3]);
    const result = toResult({ name: 'a.pdf', bytes, pageCount: 2, crc32: 7 });
    expect(result).toMatchObject({ name: 'a.pdf', size: 3, pageCount: 2, crc32: 7 });
    expect(result.url).toMatch(/^blob:/);
    expect(created[0]?.type).toBe('application/pdf');
    expect(result.blob).toBe(created[0]);
    release([result, toResult({ name: 'b.pdf', bytes, pageCount: 1, crc32: 0 })]);
    expect(revoked).toHaveLength(2);
    expect(revoked[0]).toBe(result.url);
    release([]);
    expect(revoked).toHaveLength(2);
  });
});

describe('LiveStatus', () => {
  it('has both live regions from the start, empty, and fills them later', async () => {
    const { rerender } = render(LiveStatus, { props: { status: '', error: '' } });
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status.textContent).toBe('');
    expect(alert.textContent).toBe('');
    await rerender({ status: 'Done', error: 'Broke' });
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(status.textContent).toBe('Done');
    expect(alert.textContent).toBe('Broke');
  });
});

describe('drawThumb and PageThumb', () => {
  let canvas: ReturnType<typeof stubCanvas>;

  beforeEach(() => {
    canvas = stubCanvas();
  });

  afterEach(() => {
    canvas.restore();
  });

  it('paints a page turned by a quarter on a canvas of the turned size', () => {
    const element = document.createElement('canvas');
    drawThumb(element, fakeBitmap(20, 30), 0);
    expect([element.width, element.height]).toEqual([20, 30]);
    drawThumb(element, fakeBitmap(20, 30), 90);
    expect([element.width, element.height]).toEqual([30, 20]);
    drawThumb(element, fakeBitmap(20, 30), 180);
    expect([element.width, element.height]).toEqual([20, 30]);
    drawThumb(element, fakeBitmap(20, 30), 270);
    expect([element.width, element.height]).toEqual([30, 20]);
    expect(canvas.calls).toContain('rotate 90');
    expect(canvas.calls).toContain('rotate 180');
    expect(canvas.calls).toContain('translate 15 10');
    expect(canvas.calls).toContain('drawImage -10 -15');
  });

  it('does nothing without a 2D context and survives a bitmap that was released', () => {
    const element = document.createElement('canvas');
    canvas.getContext.mockReturnValue(null);
    expect(() => {
      drawThumb(element, fakeBitmap(), 0);
    }).not.toThrow();
    canvas.getContext.mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: (): never => {
        throw new DOMException('released', 'InvalidStateError');
      },
    });
    expect(() => {
      drawThumb(element, fakeBitmap(), 0);
    }).not.toThrow();
  });

  it('shows a blank frame until the picture is there, then a hidden canvas that follows the turn', async () => {
    const { container, rerender } = render(PageThumb, { props: { bitmap: undefined } });
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.blank')?.getAttribute('aria-hidden')).toBe('true');
    await rerender({ bitmap: fakeBitmap(20, 30), turn: 0 });
    const element = container.querySelector('canvas');
    expect(element?.getAttribute('aria-hidden')).toBe('true');
    expect([element?.width, element?.height]).toEqual([20, 30]);
    await rerender({ bitmap: fakeBitmap(20, 30), turn: 90 });
    expect([element?.width, element?.height]).toEqual([30, 20]);
  });
});

describe('PageGrid', () => {
  const store = {
    bitmap: (page: number) => (page === 1 ? undefined : fakeBitmap()),
  } as unknown as ThumbnailStore;
  const pages = [0, 1, 2, 3, 4].map((id) => ({ id, turn: id === 2 ? 90 : 0 }));
  let canvas: ReturnType<typeof stubCanvas>;

  beforeEach(() => {
    canvas = stubCanvas();
  });

  afterEach(() => {
    canvas.restore();
    vi.restoreAllMocks();
  });

  function setup(props: { selected?: Set<number>; withMove?: boolean; list?: typeof pages } = {}): {
    onselect: ReturnType<typeof vi.fn>;
    onmove: ReturnType<typeof vi.fn>;
    rerender: (p: object) => Promise<void>;
  } {
    const onselect = vi.fn();
    const onmove = vi.fn();
    const result = render(PageGrid, {
      props: {
        pages: props.list ?? pages,
        selected: props.selected ?? new Set<number>(),
        store,
        label: 'Pages of a.pdf',
        pageLabel: (page: { id: number; turn: number }, position: number) =>
          `Position ${String(position)}: page ${String(page.id + 1)}`,
        onselect,
        ...(props.withMove === false ? {} : { onmove }),
      },
    });
    return { onselect, onmove, rerender: result.rerender };
  }

  it('is a multi-select listbox with one option per page, one Tab stop and names', () => {
    setup({ selected: new Set([3]) });
    const grid = screen.getByRole('listbox', { name: 'Pages of a.pdf' });
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
    const options = within(grid).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'Position 1: page 1',
      'Position 2: page 2',
      'Position 3: page 3',
      'Position 4: page 4',
      'Position 5: page 5',
    ]);
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    // Pictures are decorative; the page without a picture shows a blank frame.
    expect(grid.querySelectorAll('canvas')).toHaveLength(4);
    expect(grid.querySelectorAll('.blank')).toHaveLength(1);
  });

  it('renders nothing for no pages', () => {
    setup({ list: [] });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('toggles a page with a click and extends with Shift+click', async () => {
    const user = userEvent.setup();
    const { onselect } = setup({ selected: new Set([1]) });
    const options = screen.getAllByRole('option');
    await user.click(at(options, 3));
    expect(onselect).toHaveBeenLastCalledWith(new Set([1, 3]));
    // kern keeps the selection it reported until the parent passes a new one (this test never does).
    await user.click(at(options, 1));
    expect(onselect).toHaveBeenLastCalledWith(new Set([3]));
    await user.keyboard('{Shift>}');
    await user.click(at(options, 4));
    await user.keyboard('{/Shift}');
    // The anchor is the last page toggled (position 1): pages 2 to 5.
    expect(onselect).toHaveBeenLastCalledWith(new Set([1, 2, 3, 4]));
  });

  it('moves the focus with the arrow keys and selects with Space and Enter', async () => {
    const user = userEvent.setup();
    const { onselect } = setup();
    const options = screen.getAllByRole('option');
    at(options, 0).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(options[2]);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    await user.keyboard(' ');
    expect(onselect).toHaveBeenLastCalledWith(new Set([2]));
    await user.keyboard('{Enter}');
    expect(onselect).toHaveBeenCalledTimes(2);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(options[4]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(options[0]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(options[0]);
  });

  it('moves between rows by the number of columns of the layout', async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement): number {
        const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
        return Math.floor(index / 2) * 100;
      },
    });
    try {
      setup();
      const options = screen.getAllByRole('option');
      at(options, 0).focus();
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(options[2]);
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(options[0]);
      await user.keyboard('{PageDown}');
      expect(document.activeElement).toBe(options[4]);
      await user.keyboard('{PageUp}');
      expect(document.activeElement).toBe(options[0]);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
    }
  });

  it('extends the selection with Shift+arrow and Shift+Space, selects all and clears', async () => {
    const user = userEvent.setup();
    const { onselect } = setup({ selected: new Set([0]) });
    const options = screen.getAllByRole('option');
    at(options, 0).focus();
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(onselect).toHaveBeenLastCalledWith(new Set([0, 1, 2]));
    await user.keyboard('{Shift>} {/Shift}');
    expect(onselect).toHaveBeenLastCalledWith(new Set([0, 1, 2]));
    await user.keyboard('{Control>}a{/Control}');
    expect(onselect).toHaveBeenLastCalledWith(new Set([0, 1, 2, 3, 4]));
    await user.keyboard('{Escape}');
    expect(onselect).toHaveBeenLastCalledWith(new Set());
  });

  it('ignores Escape when nothing is selected and keys it does not know', async () => {
    const user = userEvent.setup();
    const { onselect, onmove } = setup();
    at(screen.getAllByRole('option'), 0).focus();
    await user.keyboard('{Escape}x{Meta>}{ArrowRight}{/Meta}');
    expect(onselect).not.toHaveBeenCalled();
    expect(onmove).not.toHaveBeenCalled();
  });

  it('moves a page with Alt+arrow and the focus goes with it', async () => {
    const user = userEvent.setup();
    const { onmove } = setup();
    const options = screen.getAllByRole('option');
    at(options, 1).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(onmove).toHaveBeenLastCalledWith(1, 2);
    // At the ends there is nowhere to go.
    at(options, 0).focus();
    onmove.mockClear();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(onmove).not.toHaveBeenCalled();
    // Alt with a key that does not move does nothing.
    await user.keyboard('{Alt>}x{/Alt}');
    expect(onmove).not.toHaveBeenCalled();
  });

  it('does not offer Alt+arrow moves or dragging when it cannot reorder', async () => {
    const user = userEvent.setup();
    const { onselect } = setup({ withMove: false });
    const options = screen.getAllByRole('option');
    expect(options[0]?.hasAttribute('draggable')).toBe(false);
    at(options, 1).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(onselect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options[1]);
  });

  it('moves a page by drag and drop', async () => {
    const { onmove } = setup();
    const options = screen.getAllByRole('option');
    const [first, , third] = options;
    if (first === undefined || third === undefined) {
      throw new Error('options missing');
    }
    await fireEvent(third, dragEvent('dragover', drag()));
    await fireEvent(third, dragEvent('drop', drag()));
    expect(onmove).not.toHaveBeenCalled();
    await fireEvent(first, dragEvent('dragstart', drag()));
    expect(first.className).toContain('dragging');
    await fireEvent(third, dragEvent('dragover', drag()));
    expect(third.className).toContain('drop');
    await fireEvent(third, dragEvent('drop', drag()));
    expect(onmove).toHaveBeenCalledWith(0, 2);
    onmove.mockClear();
    await fireEvent(first, dragEvent('dragstart', drag()));
    await fireEvent(first, dragEvent('drop', drag()));
    expect(onmove).not.toHaveBeenCalled();
    await fireEvent(first, dragEvent('dragstart', drag()));
    await fireEvent(third, dragEvent('dragover', drag()));
    await fireEvent(first, dragEvent('dragend', drag()));
    expect(third.className).not.toContain('drop');
    // Without a data transfer object the drag still works.
    await fireEvent(first, new Event('dragstart', { bubbles: true }));
    await fireEvent(third, new Event('dragover', { bubbles: true, cancelable: true }));
    await fireEvent(third, new Event('drop', { bubbles: true, cancelable: true }));
    expect(onmove).toHaveBeenCalledWith(0, 2);
  });

  it('keeps the Tab stop inside the grid when pages are removed', async () => {
    const user = userEvent.setup();
    const { rerender } = setup();
    at(screen.getAllByRole('option'), 0).focus();
    await user.keyboard('{End}');
    await rerender({ pages: pages.slice(0, 2) });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0]);
  });
});
