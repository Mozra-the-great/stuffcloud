import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type * as Zip from '../../src/pdf/zip.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfInput, PdfOutput, PdfRunner } from '../../src/pdf/types.ts';
import { ZipLimitError } from '../../src/pdf/zip.ts';
import manifest from '../../src/tools/pdf-split/manifest.ts';
import { makeEncryptedPdf, makePdf, pdfFile } from '../pdf-fixtures.ts';
import {
  fakeThumbs,
  inProcessOps,
  type OpsRunner,
  stubCanvas,
  stubObjectUrls,
  stubWorkerCapability,
  at,
  fileInput,
} from '../pdf-helpers.ts';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

const runners = vi.hoisted((): { ops: unknown; thumbs: unknown } => ({
  ops: undefined,
  thumbs: undefined,
}));
const zip = vi.hoisted(() => ({ failWith: undefined as Error | undefined }));

vi.mock('../../src/pdf/runners.ts', () => ({
  createOpsRunner: () => runners.ops,
  createThumbRunner: () => runners.thumbs,
}));

vi.mock('../../src/pdf/zip.ts', async (original) => {
  const actual = await original<typeof Zip>();
  return {
    ...actual,
    buildZip: (...args: Parameters<typeof actual.buildZip>): Blob => {
      if (zip.failWith !== undefined) {
        throw zip.failWith;
      }
      return actual.buildZip(...args);
    },
  };
});

let urls: ReturnType<typeof stubObjectUrls>;
let canvas: ReturnType<typeof stubCanvas>;

beforeEach(() => {
  runners.ops = inProcessOps();
  runners.thumbs = fakeThumbs();
  urls = stubObjectUrls();
  canvas = stubCanvas();
  stubWorkerCapability();
  zip.failWith = undefined;
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

async function openWith(
  count: number,
  name = 'book.pdf',
): Promise<{ user: ReturnType<typeof userEvent.setup>; main: HTMLElement }> {
  const view = await openTool(manifest);
  const user = userEvent.setup({ applyAccept: false });
  const field = view.main.querySelector('input[type="file"]');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no file input');
  }
  await user.upload(field, pdfFile(await makePdf(count), name));
  await screen.findByText(new RegExp(`^${String(count)} pages? · `));
  return { user, main: view.main };
}

describe('pdf-split', () => {
  it('keeps the privacy promise in its manifest and needs workers', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toEqual(['worker']);
  });

  it('opens at /tools/pdf-split with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/pdf-split');
    expect(view.headings).toEqual(['Split PDF']);
    expect(view.searchHits('split pdf')).toEqual(['pdf-split']);
    expect(view.searchHits('teilen')).toEqual(['pdf-split']);
    expect(screen.queryByLabelText('Split by')).toBeNull();
  });

  it('opens a file and says how many pages it has', async () => {
    await openWith(6);
    expect(live('status').textContent).toBe('book.pdf opened: 6 pages.');
    expect(screen.getByText('book.pdf')).toBeDefined();
    expect(button('Split').disabled).toBe(true);
    // Nothing is said about the empty ranges field before the visitor typed.
    expect(fieldErrorText()).toBeNull();
  });

  it('splits by ranges: preview, files, ZIP', async () => {
    const { user } = await openWith(6);
    await user.type(screen.getByLabelText('Page ranges'), '1-2, 4, 6-');
    expect(screen.getByText('This makes 3 files.')).toBeDefined();
    expect(button('Split').disabled).toBe(false);
    await user.click(button('Split'));
    await screen.findByRole('list', { name: 'Result files' });
    expect(live('status').textContent).toBe('Created 3 PDFs.');
    const items = within(screen.getByRole('list', { name: 'Result files' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.querySelector('.file-name')?.textContent)).toEqual([
      'book_pages-1-2.pdf',
      'book_page-4.pdf',
      'book_page-6.pdf',
    ]);
    expect(items[0]?.textContent).toContain('2 pages');
    const link = screen.getByRole('link', { name: 'Download book_pages-1-2.pdf' });
    expect(link.getAttribute('download')).toBe('book_pages-1-2.pdf');
    expect(link.getAttribute('href')).toMatch(/^blob:/);
    const archive = screen.getByRole('link', { name: /^Download all as ZIP \(/ });
    expect(archive.getAttribute('download')).toBe('book_split.zip');
    expect(urls.created.some((blob) => blob.type === 'application/zip')).toBe(true);
    // Checksums were asked for, because there is more than one file.
    const build = (runners.ops as OpsRunner).calls.find((call) => call.kind === 'build');
    expect(build?.kind === 'build' && build.withChecksums).toBe(true);
  });

  it('shows what is wrong with the ranges as the field error', async () => {
    const { user } = await openWith(3);
    const ranges = screen.getByLabelText('Page ranges');
    await user.type(ranges, '1-9');
    expect(screen.getByText('Page 9 does not exist: this PDF has 3 pages.')).toBeDefined();
    expect(ranges.getAttribute('aria-invalid')).toBe('true');
    expect(button('Split').disabled).toBe(true);
    await user.clear(ranges);
    await user.type(ranges, '2');
    expect(ranges.getAttribute('aria-invalid')).toBeNull();
    expect(button('Split').disabled).toBe(false);
  });

  it('splits every N pages and says what does not fit', async () => {
    const { user } = await openWith(5);
    await user.selectOptions(screen.getByLabelText('Split by'), 'every');
    const every = screen.getByLabelText('Pages per file');
    expect((every as HTMLInputElement).value).toBe('2');
    expect(screen.getByText('This makes 3 files.')).toBeDefined();
    await user.clear(every);
    expect(button('Split').disabled).toBe(true);
    await user.type(every, '9');
    expect(screen.getByText('Enter a whole number from 1 to 5.')).toBeDefined();
    await user.clear(every);
    await user.type(every, '5');
    expect(screen.getByText('This makes 1 file.')).toBeDefined();
    await user.click(button('Split'));
    await screen.findByRole('list', { name: 'Result files' });
    expect(live('status').textContent).toBe('Created 1 PDF.');
    // One file: no ZIP.
    expect(screen.queryByRole('link', { name: /ZIP/ })).toBeNull();
  });

  it('extracts the selected pages, drawing the pictures only for this mode', async () => {
    const { user } = await openWith(4);
    const thumbs = runners.thumbs as ReturnType<typeof fakeThumbs>;
    expect(thumbs.calls).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText('Split by'), 'selection');
    const grid = await screen.findByRole('listbox', { name: 'Pages of book.pdf' });
    expect(within(grid).getAllByRole('option')).toHaveLength(4);
    await waitFor(() => {
      expect(thumbs.calls.length).toBeGreaterThan(0);
    });
    expect(button('Split').disabled).toBe(true);
    expect(screen.getByText('0 pages selected')).toBeDefined();

    const options = within(grid).getAllByRole('option');
    await user.click(at(options, 3));
    await user.click(at(options, 1));
    expect(screen.getByText('2 pages selected')).toBeDefined();
    expect(screen.getByText('This makes 1 file.')).toBeDefined();
    await user.click(button('Split'));
    await screen.findByRole('link', { name: 'Download book_selection.pdf' });
    expect(live('status').textContent).toBe('Created 1 PDF.');
    // Back to ranges: the grid goes, the pictures stay cached for the next switch.
    await user.selectOptions(screen.getByLabelText('Split by'), 'ranges');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('forgets results and selection when another file is opened', async () => {
    const { user, main } = await openWith(3);
    await user.type(screen.getByLabelText('Page ranges'), '1');
    await user.click(button('Split'));
    await screen.findByRole('list', { name: 'Result files' });
    const field = fileInput(main);
    await user.upload(field, pdfFile(await makePdf(2), 'other.pdf'));
    await screen.findByText(/^2 pages · /);
    expect(screen.queryByRole('list', { name: 'Result files' })).toBeNull();
    expect(urls.revoked.length).toBeGreaterThan(0);
    expect(live('status').textContent).toBe('other.pdf opened: 2 pages.');
  });

  it('opens a file by dropping a PDF and refuses other files', async () => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const field = fileInput(view.main);
    await user.upload(field, new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(live('alert').textContent).toBe('1 file was skipped because it is not a PDF.');
  });

  it.each([
    [
      'an encrypted file',
      async () => makeEncryptedPdf(),
      /^locked\.pdf is protected with a password/,
    ],
    [
      'a damaged file',
      () => Promise.resolve(new Uint8Array([1, 2, 3])),
      /^locked\.pdf could not be read/,
    ],
  ])('says what is wrong with %s', async (_name, make, text) => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const field = fileInput(view.main);
    await user.upload(field, pdfFile(await make(), 'locked.pdf'));
    await waitFor(() => {
      expect(live('alert').textContent).toMatch(text);
    });
    expect(live('status').textContent).toBe('');
    expect(screen.queryByLabelText('Split by')).toBeNull();
  });

  it('says so when the worker fails while reading', async () => {
    runners.ops = { run: () => Promise.reject(new Error('worker died')), terminate: vi.fn() };
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const field = fileInput(view.main);
    await user.upload(field, pdfFile(await makePdf(1), 'x.pdf'));
    await waitFor(() => {
      expect(live('alert').textContent).toContain('Nothing was uploaded');
    });
  });

  it('ignores an empty file choice', async () => {
    const view = await openTool(manifest);
    const field = fileInput(view.main);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(field, []);
    expect(live('status').textContent).toBe('');
  });

  it('shows the build problem, a failing worker, and a ZIP that cannot be made', async () => {
    const { user } = await openWith(4);
    await user.type(screen.getByLabelText('Page ranges'), '1, 2');
    const ops = runners.ops as OpsRunner;
    const real = ops.run;

    ops.run = (job, options) =>
      job.kind === 'build'
        ? Promise.resolve({ kind: 'build', ok: false, issue: 'out-of-memory' })
        : real(job, options);
    await user.click(button('Split'));
    await waitFor(() => {
      expect(live('alert').textContent).toMatch(
        /^The browser ran out of memory while working on book\.pdf/,
      );
    });

    ops.run = (job, options) =>
      job.kind === 'build' ? Promise.reject(new Error('worker died')) : real(job, options);
    await user.click(button('Split'));
    await waitFor(() => {
      expect(live('alert').textContent).toContain('Nothing was uploaded');
    });
    expect(button('Split').disabled).toBe(false);

    ops.run = real;
    zip.failWith = new ZipLimitError('too big');
    await user.click(button('Split'));
    await screen.findByRole('list', { name: 'Result files' });
    expect(screen.queryByRole('link', { name: /ZIP/ })).toBeNull();
    expect(live('status').textContent).toBe('Created 2 PDFs.');

    zip.failWith = new Error('something else');
    await user.click(button('Split'));
    await waitFor(() => {
      expect(live('alert').textContent).toContain('Nothing was uploaded');
    });
  });

  it('shows progress and cancels', async () => {
    const { user } = await openWith(4);
    await user.type(screen.getByLabelText('Page ranges'), '1, 2');
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) => {
      if (job.kind !== 'build') {
        return real(job, options);
      }
      options?.onProgress?.({ completed: 2, total: 4 });
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    expect(button('Cancel').disabled).toBe(true);
    await user.click(button('Split'));
    const bar = await screen.findByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuetext')).toBe('2 of 4 steps');
    expect(live('status').textContent).toBe('Splitting…');
    await user.click(button('Cancel'));
    await waitFor(() => {
      expect(live('status').textContent).toBe('Split cancelled.');
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('does nothing when Split is pressed without a plan', async () => {
    await openWith(3);
    const split = button('Split');
    split.disabled = false;
    split.click();
    await Promise.resolve();
    expect((runners.ops as OpsRunner).calls.filter((call) => call.kind === 'build')).toHaveLength(
      0,
    );
  });

  it('works in German', async () => {
    const { i18n } = await import('../../src/i18n/index.ts');
    const { user } = await openWith(4);
    i18n.setLocale('de');
    try {
      await user.type(await screen.findByLabelText('Seitenbereiche'), '1-2');
      expect(screen.getByText('Das ergibt 1 Datei.')).toBeDefined();
      await user.click(button('Teilen'));
      await screen.findByRole('list', { name: 'Ergebnisdateien' });
      expect(live('status').textContent).toBe('1 PDF erstellt.');
    } finally {
      i18n.setLocale('en');
    }
  });

  it('stops its workers and frees its results when the page goes away', async () => {
    const { user } = await openWith(3);
    await user.type(screen.getByLabelText('Page ranges'), '1, 2');
    await user.click(button('Split'));
    await screen.findByRole('list', { name: 'Result files' });
    const ops = runners.ops as PdfRunner<PdfInput, PdfOutput> & {
      terminate: ReturnType<typeof vi.fn>;
    };
    await user.click(screen.getByRole('link', { name: 'Tools' }));
    await waitFor(() => {
      expect(ops.terminate).toHaveBeenCalled();
    });
    expect(urls.revoked.length).toBeGreaterThan(0);
  });
});
