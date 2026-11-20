import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/mac/pool.ts';
import { MAX_FILE_BYTES, MAX_FILES } from '../../src/tools/mac/oui.ts';
import { isInput, runTask } from '../../src/tools/mac/task.ts';
import { SAMPLE_MA_L, SAMPLE_MA_M, csvFile } from './mac-fixtures.ts';

describe('mac worker', () => {
  it('reads the files one after the other and reports its progress', async () => {
    const progress = vi.fn();
    const output = await runTask(
      { files: [csvFile('oui.csv', SAMPLE_MA_L), csvFile('mam.csv', SAMPLE_MA_M)] },
      { progress },
    );
    expect(output).toEqual({
      ok: true,
      prefixes: ['00A0B0', '04D5E6', '08F1A2', '1C2D3E4'],
      names: [
        'Example Networks Ltd',
        'Sample "Quoted" Devices, Inc.',
        'Test Systems GmbH',
        'Medium Block Co',
      ],
      files: [
        { name: 'oui.csv', entries: 3, skipped: 0 },
        { name: 'mam.csv', entries: 1, skipped: 0 },
      ],
    });
    expect(progress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it('names the file that is no vendor list, and stops there', async () => {
    const progress = vi.fn();
    const output = await runTask(
      { files: [csvFile('oui.csv', SAMPLE_MA_L), csvFile('notes.csv', 'a,b\n1,2\n')] },
      { progress },
    );
    expect(output).toEqual({ ok: false, error: 'columns', file: 'notes.csv' });
    expect(progress).toHaveBeenLastCalledWith(1, 2);
  });

  it('passes on the other errors of a file', async () => {
    const empty = await runTask(
      { files: [csvFile('a.csv', 'Registry,Assignment,Organization Name\n')] },
      { progress: vi.fn() },
    );
    expect(empty).toEqual({ ok: false, error: 'empty', file: 'a.csv' });
    const open = await runTask({ files: [csvFile('b.csv', '"a')] }, { progress: vi.fn() });
    expect(open).toEqual({ ok: false, error: 'unterminated', file: 'b.csv' });
  });

  it('refuses a file over the limit without reading it', async () => {
    const big = csvFile('huge.csv', '');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const text = vi.spyOn(big, 'text');
    const output = await runTask({ files: [big] }, { progress: vi.fn() });
    expect(output).toEqual({ ok: false, error: 'too-large', file: 'huge.csv' });
    expect(text).not.toHaveBeenCalled();
    const exact = csvFile('exact.csv', SAMPLE_MA_L);
    Object.defineProperty(exact, 'size', { value: MAX_FILE_BYTES });
    expect((await runTask({ files: [exact] }, { progress: vi.fn() })).ok).toBe(true);
  });

  it('starts its workers from worker.ts as modules, one at a time', () => {
    const created: { url: URL; options: WorkerOptions | undefined }[] = [];
    vi.stubGlobal(
      'Worker',
      class FakeWorker {
        readonly postMessage = vi.fn();
        readonly terminate = vi.fn();
        readonly addEventListener = vi.fn();
        constructor(url: URL, options?: WorkerOptions) {
          created.push({ url, options });
        }
      },
    );
    const pool = createPool();
    const input = { files: [csvFile('oui.csv', SAMPLE_MA_L)] };
    void pool.run(input).catch(() => undefined);
    void pool.run(input).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/mac/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});

describe('the input guard of the worker', () => {
  const file = csvFile('oui.csv', SAMPLE_MA_L);

  it('accepts one file up to the limit', () => {
    expect(isInput({ files: [file] })).toBe(true);
    expect(isInput({ files: Array.from({ length: MAX_FILES }, () => file) })).toBe(true);
  });

  it.each([
    null,
    'text',
    42,
    {},
    { files: [] },
    { files: 'oui.csv' },
    { files: [{ name: 'oui.csv' }] },
    { files: [file, 'oui.csv'] },
    { files: Array.from({ length: MAX_FILES + 1 }, () => file) },
  ])('refuses %j', (value) => {
    expect(isInput(value)).toBe(false);
  });
});
