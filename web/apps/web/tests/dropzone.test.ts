import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { matchesAccept, splitFiles } from '../src/ui/accept.ts';
import FileDropzone from '../src/ui/FileDropzone.svelte';
import { dataTransferInit, dragEvent } from './helpers.ts';

function file(name: string, type = ''): File {
  return new File(['content'], name, { type });
}

describe('matchesAccept', () => {
  it('accepts everything without a list', () => {
    expect(matchesAccept(file('a.bin'), undefined)).toBe(true);
    expect(matchesAccept(file('a.bin'), '')).toBe(true);
    expect(matchesAccept(file('a.bin'), ' , ,')).toBe(true);
  });

  it('matches extensions case-insensitively and only at the end', () => {
    expect(matchesAccept(file('doc.PDF'), '.pdf')).toBe(true);
    expect(matchesAccept(file('doc.pdf'), '.PDF')).toBe(true);
    expect(matchesAccept(file('doc.pdf.exe'), '.pdf')).toBe(false);
    expect(matchesAccept(file('pdf'), '.pdf')).toBe(false);
    expect(matchesAccept(file('doc.txt'), '.pdf')).toBe(false);
  });

  it('matches wildcard types by prefix', () => {
    expect(matchesAccept(file('a', 'image/png'), 'image/*')).toBe(true);
    expect(matchesAccept(file('a', 'IMAGE/JPEG'), 'image/*')).toBe(true);
    expect(matchesAccept(file('a', 'application/pdf'), 'image/*')).toBe(false);
    expect(matchesAccept(file('a', ''), 'image/*')).toBe(false);
    expect(matchesAccept(file('a', 'imagex/png'), 'image/*')).toBe(false);
  });

  it('matches exact types only exactly', () => {
    expect(matchesAccept(file('a', 'application/pdf'), 'application/pdf')).toBe(true);
    expect(matchesAccept(file('a', 'application/pdfx'), 'application/pdf')).toBe(false);
    expect(matchesAccept(file('a', ''), 'application/pdf')).toBe(false);
  });

  it('accepts a file that matches any one entry of the list', () => {
    const accept = ' .pdf , image/* , application/zip ';
    expect(matchesAccept(file('a.pdf'), accept)).toBe(true);
    expect(matchesAccept(file('a', 'image/gif'), accept)).toBe(true);
    expect(matchesAccept(file('a', 'application/zip'), accept)).toBe(true);
    expect(matchesAccept(file('a.txt', 'text/plain'), accept)).toBe(false);
  });
});

describe('splitFiles', () => {
  const a = file('a.pdf');
  const b = file('b.pdf');
  const c = file('c.txt');

  it('splits by accept and keeps the order', () => {
    expect(splitFiles([a, c, b], '.pdf', true)).toEqual({ accepted: [a, b], rejected: [c] });
  });

  it('without multiple keeps the first accepted file and rejects the rest', () => {
    expect(splitFiles([c, a, b], '.pdf', false)).toEqual({ accepted: [a], rejected: [c, b] });
  });

  it('without multiple a single file passes', () => {
    expect(splitFiles([a], '.pdf', false)).toEqual({ accepted: [a], rejected: [] });
  });

  it('handles an empty drop', () => {
    expect(splitFiles([], '.pdf', true)).toEqual({ accepted: [], rejected: [] });
  });
});

describe('FileDropzone', () => {
  const base = { hint: 'drop PDFs here', buttonLabel: 'Choose files' } as const;

  function input(): HTMLInputElement {
    const element = document.querySelector('input[type="file"]');
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    return element;
  }

  function zone(): HTMLElement {
    return screen.getByRole('group', { name: 'drop PDFs here' });
  }

  it('is a group named by its hint with a real button', () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    expect(zone()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeTruthy();
  });

  it('hides the input from the tab order and passes accept and multiple to it', () => {
    render(FileDropzone, { ...base, accept: '.pdf', multiple: false, onfiles: vi.fn() });
    expect(input().hidden).toBe(true);
    expect(input().tabIndex).toBe(-1);
    expect(input().accept).toBe('.pdf');
    expect(input().multiple).toBe(false);
  });

  it('is multiple by default', () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    expect(input().multiple).toBe(true);
  });

  it('the button opens the file picker, also from the keyboard', async () => {
    const user = userEvent.setup();
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    const click = vi.spyOn(input(), 'click').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Choose files' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(click).toHaveBeenCalledTimes(3);
  });

  it('delivers the picked files and resets the input so the same file can be picked again', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, onfiles });
    const pdf = file('a.pdf', 'application/pdf');
    await fireEvent.change(input(), { target: { files: [pdf] } });
    expect(onfiles).toHaveBeenCalledWith([pdf]);
    expect(input().value).toBe('');
  });

  it('ignores an empty selection', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, onfiles });
    await fireEvent.change(input(), { target: { files: [] } });
    expect(onfiles).not.toHaveBeenCalled();
  });

  it('delivers dropped files and reports the ones that do not match accept', async () => {
    const onfiles = vi.fn();
    const onreject = vi.fn();
    render(FileDropzone, { ...base, accept: '.pdf', onfiles, onreject });
    const pdf = file('a.pdf');
    const text = file('b.txt');
    await fireEvent.drop(zone(), dataTransferInit([pdf, text]));
    expect(onfiles).toHaveBeenCalledWith([pdf]);
    expect(onreject).toHaveBeenCalledWith([text]);
  });

  it('does not call onfiles when everything was rejected, and works without onreject', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, accept: '.pdf', onfiles });
    await fireEvent.drop(zone(), dataTransferInit([file('b.txt')]));
    expect(onfiles).not.toHaveBeenCalled();
  });

  it('does not call onreject when nothing was rejected', async () => {
    const onreject = vi.fn();
    render(FileDropzone, { ...base, accept: '.pdf', onfiles: vi.fn(), onreject });
    await fireEvent.drop(zone(), dataTransferInit([file('a.pdf')]));
    expect(onreject).not.toHaveBeenCalled();
  });

  it('without multiple only the first file of a drop is taken, the rest is rejected', async () => {
    const onfiles = vi.fn();
    const onreject = vi.fn();
    render(FileDropzone, { ...base, multiple: false, onfiles, onreject });
    const first = file('1.pdf');
    const second = file('2.pdf');
    await fireEvent.drop(zone(), dataTransferInit([first, second]));
    expect(onfiles).toHaveBeenCalledWith([first]);
    expect(onreject).toHaveBeenCalledWith([second]);
  });

  it('ignores a drop without files', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, onfiles });
    await fireEvent.drop(zone());
    await fireEvent.drop(zone(), dataTransferInit([]));
    expect(onfiles).not.toHaveBeenCalled();
  });

  it('shows the drag state on dragover (copy cursor) and clears it on drop', async () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    const transfer = dataTransferInit([]);
    const notCancelled = await fireEvent.dragOver(zone(), transfer);
    expect(notCancelled).toBe(false); // preventDefault: the drop is allowed
    expect(transfer.dataTransfer.dropEffect).toBe('copy');
    expect(zone().classList.contains('dragging')).toBe(true);
    await fireEvent.drop(zone(), dataTransferInit([]));
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('dragover without a dataTransfer still allows the drop', async () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    await fireEvent.dragOver(zone());
    expect(zone().classList.contains('dragging')).toBe(true);
  });

  it('clears the drag state when the pointer leaves the zone', async () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    await fireEvent.dragOver(zone());
    await fireEvent(zone(), dragEvent('dragleave', { relatedTarget: document.body }));
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('clears the drag state when the pointer leaves without a related target', async () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    await fireEvent.dragOver(zone());
    await fireEvent.dragLeave(zone());
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('keeps the drag state while the pointer moves onto a child (no flicker)', async () => {
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    await fireEvent.dragOver(zone());
    await fireEvent(
      zone(),
      dragEvent('dragleave', {
        relatedTarget: screen.getByRole('button', { name: 'Choose files' }),
      }),
    );
    expect(zone().classList.contains('dragging')).toBe(true);
  });

  it('when disabled: the button is disabled and drops are neither accepted nor allowed', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, disabled: true, onfiles });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Choose files' }).disabled).toBe(
      true,
    );
    expect(input().disabled).toBe(true);
    const allowed = await fireEvent.dragOver(zone(), dataTransferInit([]));
    expect(allowed).toBe(true); // not cancelled: the browser refuses the drop
    expect(zone().classList.contains('dragging')).toBe(false);
    const dropped = await fireEvent.drop(zone(), dataTransferInit([file('a.pdf')]));
    expect(dropped).toBe(true);
    expect(onfiles).not.toHaveBeenCalled();
  });

  it('never reads file content: only name and type are looked at (files stay on the device)', async () => {
    const onfiles = vi.fn();
    render(FileDropzone, { ...base, accept: '.pdf,image/*', onfiles });
    const spied = file('a.pdf', 'application/pdf');
    // Any attempt to read the content is recorded (jsdom's File lacks stream() and bytes()).
    const reads: string[] = [];
    for (const method of ['arrayBuffer', 'text', 'stream', 'slice', 'bytes']) {
      Object.defineProperty(spied, method, {
        value: (): void => {
          reads.push(method);
        },
      });
    }
    const readerCalls = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    await fireEvent.drop(zone(), dataTransferInit([spied]));
    expect(onfiles).toHaveBeenCalledWith([spied]);
    expect(reads).toEqual([]);
    expect(readerCalls).not.toHaveBeenCalled();
  });

  it('makes no network request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(FileDropzone, { ...base, onfiles: vi.fn() });
    await fireEvent.drop(zone(), dataTransferInit([file('a.pdf')]));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
