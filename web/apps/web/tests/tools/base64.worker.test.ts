import { describe, expect, it, vi } from 'vitest';
import { MAX_DECODE_FILE_BYTES, MAX_FILE_BYTES } from '../../src/tools/base64/codec.ts';
import { createPool } from '../../src/tools/base64/pool.ts';
import {
  CHUNK_BYTES,
  isInput,
  runTask,
  transfer,
  type Input,
  type Output,
} from '../../src/tools/base64/task.ts';

const options = { urlSafe: false, padding: true, lineLength: 0 } as const;

function progressLog(): {
  calls: [number, number][];
  progress: (done: number, total: number) => void;
} {
  const calls: [number, number][] = [];
  return {
    calls,
    progress: (done, total) => {
      calls.push([done, total]);
    },
  };
}

describe('base64 worker task', () => {
  it('encodes a file and reports its progress', async () => {
    const log = progressLog();
    const output = await runTask(
      { op: 'encode', file: new Blob(['foobar']), options },
      { progress: log.progress },
    );
    expect(output).toEqual({ ok: true, kind: 'encoded', text: 'Zm9vYmFy', size: 6 });
    expect(log.calls.at(-1)).toEqual([6, 6]);
  });

  it('encodes an empty file as nothing', async () => {
    const log = progressLog();
    const output = await runTask(
      { op: 'encode', file: new Blob([]), options },
      { progress: log.progress },
    );
    expect(output).toEqual({ ok: true, kind: 'encoded', text: '', size: 0 });
    expect(log.calls.at(-1)).toEqual([1, 1]);
  });

  it('encodes a file bigger than one piece the same as the whole', async () => {
    const data = new Uint8Array(CHUNK_BYTES * 2 + 1000).map((_, index) => (index * 31) % 251);
    const log = progressLog();
    const output = await runTask(
      { op: 'encode', file: new Blob([data]), options: { ...options, lineLength: 76 } },
      { progress: log.progress },
    );
    const expected = Buffer.from(data)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\n');
    expect(output).toMatchObject({ ok: true, kind: 'encoded', text: expected, size: data.length });
    expect(log.calls.length).toBeGreaterThanOrEqual(4);
    expect(log.calls[0]?.[0]).toBe(CHUNK_BYTES);
  });

  it('writes a data URI as one standard padded line', async () => {
    const output = await runTask(
      {
        op: 'encode',
        file: new Blob([new Uint8Array([0xfb, 0xff])]),
        options: { urlSafe: true, padding: false, lineLength: 76 },
        mediaType: 'image/png',
      },
      { progress: vi.fn() },
    );
    expect(output).toMatchObject({ text: 'data:image/png;base64,+/8=' });
  });

  it('decodes a file of Base64 text and passes on the media type of a data URI', async () => {
    const output = await runTask(
      { op: 'decode', file: new Blob(['data:text/plain;base64,Zm9v']) },
      { progress: vi.fn() },
    );
    expect(output.ok && output.kind === 'decoded' ? [...output.bytes] : []).toEqual([
      102, 111, 111,
    ]);
    expect(output).toMatchObject({ mediaType: 'text/plain' });
    const plainOutput = await runTask(
      { op: 'decode', file: new Blob(['Zm9v']) },
      { progress: vi.fn() },
    );
    expect(plainOutput).not.toHaveProperty('mediaType');
  });

  it('answers a file that is not Base64 with the position of the problem', async () => {
    const output = await runTask(
      { op: 'decode', file: new Blob(['Zm9v\n!']) },
      { progress: vi.fn() },
    );
    expect(output).toMatchObject({
      ok: false,
      error: { code: 'invalidChar', line: 2, column: 1, found: '!' },
    });
  });

  it('refuses a file that is too large, without reading it', async () => {
    const big = (size: number): Blob =>
      ({ size, slice: () => new Blob([]), text: () => Promise.resolve('') }) as unknown as Blob;
    await expect(
      runTask({ op: 'encode', file: big(MAX_FILE_BYTES + 1), options }, { progress: vi.fn() }),
    ).rejects.toThrow('too large to encode');
    await expect(
      runTask({ op: 'decode', file: big(MAX_DECODE_FILE_BYTES + 1) }, { progress: vi.fn() }),
    ).rejects.toThrow('too large to decode');
  });

  it('moves the bytes it decoded and copies nothing else', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(transfer({ ok: true, kind: 'decoded', bytes })).toEqual([bytes.buffer]);
    expect(transfer({ ok: true, kind: 'encoded', text: 'x', size: 1 })).toEqual([]);
    expect(
      transfer({ ok: false, error: { code: 'empty', offset: 0, line: 1, column: 1 } }),
    ).toEqual([]);
  });

  it('checks what the page sends', () => {
    const file = new Blob(['x']);
    expect(isInput({ op: 'decode', file })).toBe(true);
    expect(isInput({ op: 'encode', file, options })).toBe(true);
    expect(isInput({ op: 'encode', file, options, mediaType: 'text/plain' })).toBe(true);
    for (const broken of [
      null,
      'x',
      { op: 'decode' },
      { op: 'decode', file: 'x' },
      { op: 'other', file },
      { op: 'encode', file },
      { op: 'encode', file, options: { ...options, lineLength: 80 } },
      { op: 'encode', file, options: { ...options, urlSafe: 'yes' } },
      { op: 'encode', file, options: null },
      { op: 'encode', file, options, mediaType: 'not a type' },
      { op: 'encode', file, options, mediaType: 5 },
    ]) {
      expect(isInput(broken)).toBe(false);
    }
  });

  it('starts its workers from worker.ts as modules', () => {
    const created: { url: URL; options: WorkerOptions | undefined }[] = [];
    vi.stubGlobal(
      'Worker',
      class FakeWorker {
        readonly postMessage = vi.fn();
        readonly terminate = vi.fn();
        readonly addEventListener = vi.fn();
        constructor(url: URL, workerOptions?: WorkerOptions) {
          created.push({ url, options: workerOptions });
        }
      },
    );
    const pool = createPool();
    const input: Input = { op: 'decode', file: new Blob(['x']) };
    void pool.run(input).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/base64/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
    const output: Output = { ok: false, error: { code: 'empty', offset: 0, line: 1, column: 1 } };
    expect(output.ok).toBe(false);
  });
});
