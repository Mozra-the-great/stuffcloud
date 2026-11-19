import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MERGE_FILES, MAX_TOTAL_INPUT_BYTES } from '../../src/pdf/limits.ts';
import type { PdfInput, PdfOutput, PdfRunner } from '../../src/pdf/types.ts';
import manifest from '../../src/tools/pdf-merge/manifest.ts';
import { makeEncryptedPdf, makePdf, pdfFile } from '../pdf-fixtures.ts';
import {
  inProcessOps,
  type OpsRunner,
  stubObjectUrls,
  stubWorkerCapability,
} from '../pdf-helpers.ts';
import { openTool } from '../tool-helpers.ts';

const runners = vi.hoisted((): { ops: unknown } => ({ ops: undefined }));

vi.mock('../../src/pdf/runners.ts', () => ({
  createOpsRunner: () => runners.ops,
  createThumbRunner: () => {
    throw new Error('the merge tool draws no pictures');
  },
}));

let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  runners.ops = inProcessOps();
  urls = stubObjectUrls();
  stubWorkerCapability();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function input(container: HTMLElement): HTMLInputElement {
  const found = container.querySelector('input[type="file"]');
  if (!(found instanceof HTMLInputElement)) {
    throw new Error('no file input');
  }
  return found;
}

function names(): string[] {
  return within(screen.getByRole('list', { name: 'PDFs to merge, in this order' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.name')?.textContent ?? '');
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name });
}

function live(role: 'status' | 'alert'): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.live [role="${role}"]`);
  if (found === null) {
    throw new Error(`no ${role} region`);
  }
  return found;
}

const status = (): HTMLElement => live('status');
const alert = (): HTMLElement => live('alert');

async function addTwo(container: HTMLElement): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup({ applyAccept: false });
  await user.upload(input(container), [
    pdfFile(await makePdf(2), 'a.pdf'),
    pdfFile(await makePdf([{ width: 200 }, { width: 201 }, { width: 202 }]), 'b.pdf'),
  ]);
  await waitFor(() => {
    expect(screen.queryByText('Reading file…')).toBeNull();
  });
  return user;
}

describe('pdf-merge', () => {
  it('keeps the privacy promise in its manifest and needs workers', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toEqual(['worker']);
  });

  it('opens at /tools/pdf-merge with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/pdf-merge');
    expect(view.headings).toEqual(['Merge PDFs']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
    expect(button('Merge').disabled).toBe(true);
    expect(screen.getByText('Add at least two PDFs to merge them.')).toBeDefined();
  });

  it('is found by search in both languages of its keywords', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('merge pdfs')).toEqual(['pdf-merge']);
    expect(view.searchHits('zusammenfügen')).toEqual(['pdf-merge']);
  });

  it('merges the files in the order of the list and offers the download', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
    expect(screen.getByText(/^2 pages · /)).toBeDefined();
    expect(screen.getByText(/^3 pages · /)).toBeDefined();
    expect(status().textContent).toBe('2 PDFs added.');
    expect(button('Merge').disabled).toBe(false);

    await user.click(button('Move b.pdf up'));
    expect(names()).toEqual(['b.pdf', 'a.pdf']);
    expect(status().textContent).toBe('b.pdf is now number 1 of 2.');
    await user.click(button('Move b.pdf down'));
    expect(names()).toEqual(['a.pdf', 'b.pdf']);

    await user.click(button('Merge'));
    const link = await screen.findByRole('link', { name: 'Download merged.pdf' });
    expect(link.getAttribute('download')).toBe('merged.pdf');
    expect(link.getAttribute('href')).toMatch(/^blob:/);
    expect(status().textContent).toMatch(/^Merged 2 files into one PDF: 5 pages, /);
    const ops = runners.ops as OpsRunner;
    const build = ops.calls.find((call) => call.kind === 'build');
    expect(build?.kind === 'build' && build.outputs[0]?.parts.map((part) => part.source)).toEqual([
      0, 1,
    ]);
    expect(build?.kind === 'build' && build.withChecksums).toBe(false);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('forgets the result when the list changes', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    await user.click(button('Merge'));
    await screen.findByRole('link', { name: 'Download merged.pdf' });
    await user.click(button('Move a.pdf down'));
    expect(screen.queryByRole('link', { name: 'Download merged.pdf' })).toBeNull();
    expect(urls.revoked).toHaveLength(1);
  });

  it('removes one file and all files', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    await user.click(button('Remove a.pdf'));
    expect(names()).toEqual(['b.pdf']);
    expect(status().textContent).toBe('a.pdf removed.');
    expect(button('Merge').disabled).toBe(true);
    await user.click(button('Remove all'));
    expect(screen.queryByRole('list', { name: 'PDFs to merge, in this order' })).toBeNull();
    expect(status().textContent).toBe('All files removed.');
    expect(button('Remove all').disabled).toBe(true);
  });

  it('shows what is wrong with a file and keeps the others', async () => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input(view.main), [
      pdfFile(await makePdf(1), 'good.pdf'),
      pdfFile(await makeEncryptedPdf(), 'locked.pdf'),
      pdfFile(new Uint8Array([1, 2, 3]), 'broken.pdf'),
    ]);
    await screen.findByText(/locked\.pdf is protected with a password/);
    await screen.findByText('broken.pdf could not be read: it is damaged or not a PDF.');
    expect(button('Merge').disabled).toBe(true);
  });

  it('treats a worker that fails while reading as a broken file', async () => {
    runners.ops = {
      run: () => Promise.reject(new Error('worker crashed')),
      terminate: vi.fn(),
    } satisfies PdfRunner<PdfInput, PdfOutput>;
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input(view.main), [pdfFile(await makePdf(1), 'x.pdf')]);
    await screen.findByText('x.pdf could not be read: it is damaged or not a PDF.');
  });

  it('reports files that are not PDFs', async () => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input(view.main), [new File(['x'], 'a.txt', { type: 'text/plain' })]);
    expect(alert().textContent).toBe('1 file was skipped because it is not a PDF.');
  });

  it('adds files in several rounds and numbers nothing twice', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    await user.upload(input(view.main), [pdfFile(await makePdf(1), 'c.pdf')]);
    expect(status().textContent).toBe('1 PDF added.');
    expect(names()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('refuses more files than may be merged and files over the size limit', async () => {
    const view = await openTool(manifest);
    const user = userEvent.setup({ applyAccept: false });
    const bytes = await makePdf(1);
    const many = Array.from({ length: MAX_MERGE_FILES + 1 }, (_, n) =>
      pdfFile(bytes, `f${String(n)}.pdf`),
    );
    await user.upload(input(view.main), many);
    expect(alert().textContent).toMatch(/^Some files were not added: at most 200 files/);
    expect(names()).toHaveLength(MAX_MERGE_FILES);

    const huge = pdfFile(bytes, 'huge.pdf');
    Object.defineProperty(huge, 'size', { value: MAX_TOTAL_INPUT_BYTES });
    await user.click(button('Remove all'));
    await user.upload(input(view.main), [pdfFile(bytes, 'one.pdf'), huge]);
    expect(alert().textContent).toMatch(/^Some files were not added/);
    expect(names()).toEqual(['one.pdf']);
  });

  it('names the file that the build found unusable, or all files when it is none in particular', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) =>
      job.kind === 'build'
        ? Promise.resolve({ kind: 'build', ok: false, issue: 'broken', source: 1 })
        : real(job, options);
    await user.click(button('Merge'));
    expect(
      (await waitFor(() => {
        expect(alert().textContent).not.toBe('');
      }),
      alert()).textContent,
    ).toBe('b.pdf could not be read: it is damaged or not a PDF.');
    ops.run = (job, options) =>
      job.kind === 'build'
        ? Promise.resolve({ kind: 'build', ok: false, issue: 'out-of-memory' })
        : real(job, options);
    await user.click(button('Merge'));
    await waitFor(() => {
      expect(alert().textContent).toBe(
        'The browser ran out of memory while working on the files. Close other tabs or use a smaller file.',
      );
    });
  });

  it('says so when the worker itself fails', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) =>
      job.kind === 'build' ? Promise.reject(new Error('worker died')) : real(job, options);
    await user.click(button('Merge'));
    await waitFor(() => {
      expect(alert().textContent).toContain('Nothing was uploaded');
    });
    expect(status().textContent).toBe('');
    expect(button('Merge').disabled).toBe(false);
  });

  it('shows progress while it works and stops when Cancel is pressed', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    const ops = runners.ops as OpsRunner;
    const real = ops.run;
    ops.run = (job, options) => {
      if (job.kind !== 'build') {
        return real(job, options);
      }
      options?.onProgress?.({ completed: 1, total: 3 });
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    expect(button('Cancel').disabled).toBe(true);
    await user.click(button('Merge'));
    const bar = await screen.findByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuetext')).toBe('1 of 3 steps');
    expect(status().textContent).toBe('Merging…');
    expect(button('Merge').disabled).toBe(true);
    await user.click(button('Cancel'));
    await waitFor(() => {
      expect(status().textContent).toBe('Merge cancelled.');
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(button('Merge').disabled).toBe(false);
  });

  it('works in German', async () => {
    const view = await openTool(manifest);
    const { i18n } = await import('../../src/i18n/index.ts');
    i18n.setLocale('de');
    await waitFor(() => {
      expect(view.main.textContent).toContain('Füge mindestens zwei PDFs hinzu');
    });
    const user = await addTwo(view.main);
    await user.click(button('a.pdf nach unten'));
    expect(status().textContent).toBe('a.pdf steht jetzt an Stelle 2 von 2.');
    i18n.setLocale('en');
  });

  it('stops its workers and frees its result when the page goes away', async () => {
    const view = await openTool(manifest);
    const user = await addTwo(view.main);
    await user.click(button('Merge'));
    await screen.findByRole('link', { name: 'Download merged.pdf' });
    const ops = runners.ops as OpsRunner;
    await user.click(screen.getByRole('link', { name: 'Tools' }));
    await waitFor(() => {
      expect(ops.terminate).toHaveBeenCalled();
    });
    expect(urls.revoked.length).toBeGreaterThan(0);
  });
});
