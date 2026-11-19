import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThumbOutput } from '../../src/pdf/types.ts';
import manifest from '../../src/tools/pdf-pages/manifest.ts';
import { makeEncryptedPdf, makePdf, pdfFile, rotationsOf, widthsOf } from '../pdf-fixtures.ts';
import {
  fakeThumbs,
  inProcessOps,
  type OpsRunner,
  stubCanvas,
  stubObjectUrls,
  stubWorkerCapability,
  fileInput,
  at,
} from '../pdf-helpers.ts';
import { openTool } from '../tool-helpers.ts';

const runners = vi.hoisted((): { ops: unknown; thumbs: unknown } => ({
  ops: undefined,
  thumbs: undefined,
}));

vi.mock('../../src/pdf/runners.ts', () => ({
  createOpsRunner: () => runners.ops,
  createThumbRunner: () => runners.thumbs,
}));

let urls: ReturnType<typeof stubObjectUrls>;
let canvas: ReturnType<typeof stubCanvas>;

beforeEach(() => {
  runners.ops = inProcessOps();
  runners.thumbs = fakeThumbs();
  urls = stubObjectUrls();
  canvas = stubCanvas();
  stubWorkerCapability();
});

afterEach(() => {
  canvas.restore();
  vi.unstubAllGlobals();
});

function live(role: 'status' | 'alert'): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.live [role="${role}"]`);
  if (found === null) {
    throw new Error(`no ${role} region`);
  }
  return found;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name });
}

const options = (): HTMLElement[] => screen.queryAllByRole('option');
const labels = (): (string | null)[] =>
  options().map((option) => option.getAttribute('aria-label'));

async function openWith(
  count: number,
): Promise<{ user: ReturnType<typeof userEvent.setup>; main: HTMLElement }> {
  const view = await openTool(manifest);
  const user = userEvent.setup({ applyAccept: false });
  const field = view.main.querySelector('input[type="file"]');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no file input');
  }
  await user.upload(field, pdfFile(await makePdf(count), 'doc.pdf'));
  await screen.findByRole('listbox', { name: 'Pages of doc.pdf' });
  return { user, main: view.main };
}

/** Clicks the pages at these positions (selects them). */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  ...positions: number[]
): Promise<void> {
  for (const position of positions) {
    await user.click(at(options(), position));
  }
}

async function saved(user: ReturnType<typeof userEvent.setup>): Promise<Blob> {
  await user.click(button('Save PDF'));
  await screen.findByRole('link', { name: 'Download doc_edited.pdf' });
  const blob = urls.created.at(-1);
  if (blob === undefined) {
    throw new Error('nothing was saved');
  }
  return blob;
}

describe('pdf-pages', () => {
  it('keeps the privacy promise in its manifest and needs workers', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toEqual(['worker']);
  });

  it('opens at /tools/pdf-pages with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/pdf-pages');
    expect(view.headings).toEqual(['Rotate, delete, reorder PDF pages']);
    expect(view.searchHits('reorder')).toEqual(['pdf-pages']);
    expect(view.searchHits('drehen')).toEqual(['pdf-pages']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens a file, shows its pages and starts drawing the pictures', async () => {
    await openWith(4);
    expect(live('status').textContent).toBe('doc.pdf opened: 4 pages.');
    expect(labels()).toEqual([
      'Position 1: page 1',
      'Position 2: page 2',
      'Position 3: page 3',
      'Position 4: page 4',
    ]);
    expect(screen.getByText('4 of 4 pages kept')).toBeDefined();
    expect(screen.getByText('The PDF is unchanged so far.')).toBeDefined();
    await waitFor(() => {
      expect(document.querySelectorAll('[role="option"] canvas')).toHaveLength(4);
    });
    expect(screen.queryByText(/could not be drawn/)).toBeNull();
  });

  it('turns the selected pages and announces it', async () => {
    const { user } = await openWith(3);
    await pick(user, 1);
    await user.click(button('Turn right'));
    expect(live('status').textContent).toBe('Turned 1 page right.');
    expect(labels()[1]).toBe('Position 2: page 2, turned 90 degrees clockwise');
    await pick(user, 0);
    await user.click(button('Turn left'));
    expect(live('status').textContent).toBe('Turned 2 pages left.');
    expect(labels()).toEqual([
      'Position 1: page 1, turned 270 degrees clockwise',
      'Position 2: page 2',
      'Position 3: page 3',
    ]);
    expect(screen.queryByText('The PDF is unchanged so far.')).toBeNull();
  });

  it('deletes pages, says when none are left and brings them back with undo', async () => {
    const { user } = await openWith(3);
    await pick(user, 0, 1, 2);
    await user.click(button('Delete'));
    expect(live('status').textContent).toBe('Deleted 3 pages.');
    expect(options()).toHaveLength(0);
    expect(screen.getByText('All pages are deleted. Undo to bring them back.')).toBeDefined();
    expect(button('Save PDF').disabled).toBe(true);
    expect(screen.getByText('0 of 3 pages kept')).toBeDefined();
    await user.click(button('Undo'));
    expect(live('status').textContent).toBe('Undone: Deleted 3 pages.');
    expect(options()).toHaveLength(3);
    expect(button('Save PDF').disabled).toBe(false);
  });

  it('keeps only the pages that still exist selected after undo and redo', async () => {
    const { user } = await openWith(3);
    await pick(user, 2);
    await user.click(button('Delete'));
    await user.click(button('Undo'));
    await pick(user, 2);
    expect(screen.getByText('1 page selected')).toBeDefined();
    await user.click(button('Redo'));
    expect(live('status').textContent).toBe('Redone: Deleted 1 page.');
    expect(screen.getByText('0 pages selected')).toBeDefined();
    expect(options()).toHaveLength(2);
  });

  it('moves the selection earlier, later, to the start, to the end and to a position', async () => {
    const { user } = await openWith(5);
    await pick(user, 2);
    await user.click(button('Move earlier'));
    expect(live('status').textContent).toBe('Moved 1 page one place earlier.');
    expect(labels().slice(0, 3)).toEqual([
      'Position 1: page 1',
      'Position 2: page 3',
      'Position 3: page 2',
    ]);
    await user.click(button('Move later'));
    expect(live('status').textContent).toBe('Moved 1 page one place later.');
    await user.click(button('To the start'));
    expect(live('status').textContent).toBe('Moved 1 page to the start.');
    expect(labels()[0]).toBe('Position 1: page 3');
    await user.click(button('To the end'));
    expect(live('status').textContent).toBe('Moved 1 page to the end.');
    expect(labels()[4]).toBe('Position 5: page 3');
    await user.type(screen.getByLabelText('Move selected pages to position'), '2{Enter}');
    expect(live('status').textContent).toBe('Moved 1 page to position 2.');
    expect(labels()[1]).toBe('Position 2: page 3');
  });

  it('refuses a position that does not exist and clears the error on the next step', async () => {
    const { user } = await openWith(3);
    await pick(user, 0);
    const field = screen.getByLabelText('Move selected pages to position');
    await user.type(field, '9{Enter}');
    expect(screen.getByText('Enter a whole number from 1 to 3.')).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await user.clear(field);
    await user.type(field, '3{Enter}');
    expect(screen.queryByText('Enter a whole number from 1 to 3.')).toBeNull();
    await user.click(button('Turn right'));
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('asks for a selection first, for every action that needs one', async () => {
    const { user } = await openWith(3);
    for (const name of [
      'Turn left',
      'Turn right',
      'Delete',
      'Move earlier',
      'Move later',
      'To the start',
      'To the end',
    ]) {
      await user.click(button(name));
      expect(live('alert').textContent).toBe('Select one or more pages first.');
      await user.click(button('Select all'));
      await user.click(button('Select none'));
    }
    // Nothing changed.
    expect(screen.getByText('The PDF is unchanged so far.')).toBeDefined();
    // An action that needs a selection also answers to the keyboard when the button is marked unavailable.
    expect(button('Delete').getAttribute('aria-disabled')).toBe('true');
    expect(button('Undo').getAttribute('aria-disabled')).toBe('true');
    expect(button('Redo').getAttribute('aria-disabled')).toBe('true');
  });

  it('says that there is nothing to undo or redo', async () => {
    const { user } = await openWith(2);
    await user.click(button('Undo'));
    expect(live('status').textContent).toBe('Nothing to undo.');
    await user.click(button('Redo'));
    expect(live('status').textContent).toBe('Nothing to redo.');
  });

  it('undoes and redoes with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, but not inside a text field', async () => {
    const { user } = await openWith(3);
    await pick(user, 0);
    await user.click(button('Delete'));
    expect(options()).toHaveLength(2);
    await user.keyboard('{Control>}z{/Control}');
    expect(options()).toHaveLength(3);
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(options()).toHaveLength(2);
    await user.keyboard('{Control>}z{/Control}');
    await user.keyboard('{Control>}y{/Control}');
    expect(options()).toHaveLength(2);
    // A text field keeps its own undo.
    await user.click(screen.getByLabelText('Move selected pages to position'));
    await user.keyboard('{Control>}z{/Control}');
    expect(options()).toHaveLength(2);
    // Other keys and keys without Ctrl do nothing.
    await user.keyboard('{Escape}z');
    expect(options()).toHaveLength(2);
    await user.keyboard('{Control>}q{/Control}');
    expect(options()).toHaveLength(2);
  });

  it('moves a page with Alt+arrow and by drag and drop', async () => {
    const { user } = await openWith(4);
    options()[0]?.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(labels().slice(0, 2)).toEqual(['Position 1: page 2', 'Position 2: page 1']);
    expect(live('status').textContent).toBe('Moved 1 page to position 2.');

    const [first, , third] = options();
    if (first === undefined || third === undefined) {
      throw new Error('options missing');
    }
    const transfer = { setData: (): void => undefined, effectAllowed: '', dropEffect: '' };
    const drag = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      return event;
    };
    await fireEvent(first, drag('dragstart'));
    await fireEvent(third, drag('dragover'));
    await fireEvent(third, drag('drop'));
    expect(labels()[2]).toBe('Position 3: page 2');
    expect(live('status').textContent).toBe('Moved 1 page to position 3.');
  });

  it('saves the pages as they are in the grid: order, turns and deletions', async () => {
    const { user } = await openWith(5);
    await pick(user, 0, 1);
    await user.click(button('Turn left'));
    await user.click(button('Select none'));
    await pick(user, 4);
    await user.click(button('To the start'));
    await user.click(button('Select none'));
    await pick(user, 3);
    await user.click(button('Delete'));
    const blob = await saved(user);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(await widthsOf(bytes)).toEqual([104, 100, 101, 103]);
    expect(await rotationsOf(bytes)).toEqual([0, 270, 270, 0]);
    expect(live('status').textContent).toMatch(/^Saved: 4 pages, /);
    const link = screen.getByRole('link', { name: 'Download doc_edited.pdf' });
    expect(link.getAttribute('download')).toBe('doc_edited.pdf');
    // Any further edit forgets the saved file.
    await pick(user, 0);
    await user.click(button('Turn right'));
    expect(screen.queryByRole('link', { name: 'Download doc_edited.pdf' })).toBeNull();
    expect(urls.revoked.length).toBeGreaterThan(0);
  });

  it('shows progress and cancels a save', async () => {
    const { user } = await openWith(2);
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) => {
      if (job.kind !== 'build') {
        return real(job, options);
      }
      options?.onProgress?.({ completed: 1, total: 2 });
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    expect(button('Cancel').disabled).toBe(true);
    await user.click(button('Save PDF'));
    const bar = await screen.findByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuetext')).toBe('1 of 2 steps');
    expect(live('status').textContent).toBe('Saving…');
    await user.click(button('Cancel'));
    await waitFor(() => {
      expect(live('status').textContent).toBe('Saving cancelled.');
    });
    expect(button('Save PDF').disabled).toBe(false);
  });

  it('shows the build problem and a failing worker when saving', async () => {
    const { user } = await openWith(2);
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) =>
      job.kind === 'build'
        ? Promise.resolve({ kind: 'build', ok: false, issue: 'broken', source: 0 })
        : real(job, options);
    await user.click(button('Save PDF'));
    await waitFor(() => {
      expect(live('alert').textContent).toBe(
        'doc.pdf could not be read: it is damaged or not a PDF.',
      );
    });
    ops.run = (job, options) =>
      job.kind === 'build' ? Promise.reject(new Error('worker died')) : real(job, options);
    await user.click(button('Save PDF'));
    await waitFor(() => {
      expect(live('alert').textContent).toContain('Nothing was uploaded');
    });
  });

  it('does nothing when saving is asked without pages', async () => {
    const { user } = await openWith(1);
    await pick(user, 0);
    await user.click(button('Delete'));
    const save = button('Save PDF');
    save.disabled = false;
    save.click();
    await Promise.resolve();
    expect((runners.ops as OpsRunner).calls.filter((call) => call.kind === 'build')).toHaveLength(
      0,
    );
    expect(user).toBeDefined();
  });

  it('mentions pictures that could not be drawn', async () => {
    runners.thumbs = {
      run: (): Promise<ThumbOutput> => Promise.resolve({ ok: false, issue: 'broken' }),
      terminate: vi.fn(),
    };
    await openWith(2);
    await screen.findByText(
      'Some page pictures could not be drawn. The pages themselves are fine.',
    );
  });

  it.each([
    ['encrypted', () => makeEncryptedPdf(), /^doc\.pdf is protected with a password/],
    ['damaged', () => Promise.resolve(new Uint8Array([1, 2])), /^doc\.pdf could not be read/],
  ])('says what is wrong with a %s file', async (_name, make, text) => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const field = fileInput(view.main);
    await user.upload(field, pdfFile(await make(), 'doc.pdf'));
    await waitFor(() => {
      expect(live('alert').textContent).toMatch(text);
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says so when the worker fails while reading, and when a file is not a PDF', async () => {
    runners.ops = { run: () => Promise.reject(new Error('worker died')), terminate: vi.fn() };
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const field = fileInput(view.main);
    await user.upload(field, pdfFile(await makePdf(1), 'doc.pdf'));
    await waitFor(() => {
      expect(live('alert').textContent).toContain('Nothing was uploaded');
    });
    await user.upload(field, new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(live('alert').textContent).toBe('1 file was skipped because it is not a PDF.');
    await user.upload(field, []);
  });

  it('starts from the new file when another one is opened', async () => {
    const { user, main } = await openWith(3);
    await pick(user, 0);
    await user.click(button('Delete'));
    const field = fileInput(main);
    await user.upload(field, pdfFile(await makePdf(2), 'doc.pdf'));
    await waitFor(() => {
      expect(options()).toHaveLength(2);
    });
    expect(screen.getByText('The PDF is unchanged so far.')).toBeDefined();
    expect(screen.getByText('0 pages selected')).toBeDefined();
  });

  it('works in German', async () => {
    const { i18n } = await import('../../src/i18n/index.ts');
    const { user } = await openWith(3);
    i18n.setLocale('de');
    try {
      await pick(user, 1);
      await user.click(await screen.findByRole('button', { name: 'Nach rechts drehen' }));
      expect(live('status').textContent).toBe('1 Seite nach rechts gedreht.');
      await user.click(screen.getByRole('button', { name: 'Rückgängig' }));
      expect(live('status').textContent).toBe('Rückgängig gemacht: 1 Seite nach rechts gedreht.');
      expect(
        within(screen.getByRole('listbox')).getAllByRole('option')[1]?.getAttribute('aria-label'),
      ).toBe('Position 2: Seite 2');
    } finally {
      i18n.setLocale('en');
    }
  });

  it('stops its workers and frees its result when the page goes away', async () => {
    const { user } = await openWith(2);
    await saved(user);
    const ops = runners.ops as OpsRunner;
    await user.click(screen.getByRole('link', { name: 'Tools' }));
    await waitFor(() => {
      expect(ops.terminate).toHaveBeenCalled();
    });
    expect(urls.revoked.length).toBeGreaterThan(0);
  });
});
