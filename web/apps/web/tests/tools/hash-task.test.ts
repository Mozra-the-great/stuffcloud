import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/hash/pool.ts';
import { CHUNK_SIZE, isInput, runTask } from '../../src/tools/hash/task.ts';

function noise(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isInput', () => {
  it('accepts an object with a file or blob', () => {
    expect(isInput({ file: new Blob(['x']) })).toBe(true);
    expect(isInput({ file: new File(['x'], 'a.txt') })).toBe(true);
  });

  it('refuses everything else', () => {
    expect(isInput(null)).toBe(false);
    expect(isInput('file')).toBe(false);
    expect(isInput({})).toBe(false);
    expect(isInput({ file: 'text' })).toBe(false);
    expect(isInput({ text: 'x' })).toBe(false);
  });
});

describe('runTask', () => {
  it('hashes a small file under every algorithm and reports it done', async () => {
    const progress = vi.fn<(completed: number, total: number) => void>();
    const data = noise(1000);
    const output = await runTask({ file: new Blob([data]) }, { progress });
    expect(output.size).toBe(1000);
    expect(output.digests['SHA-1']).toBe(createHash('sha1').update(data).digest('hex'));
    expect(output.digests['SHA-256']).toBe(createHash('sha256').update(data).digest('hex'));
    expect(output.digests['SHA-384']).toBe(createHash('sha384').update(data).digest('hex'));
    expect(output.digests['SHA-512']).toBe(createHash('sha512').update(data).digest('hex'));
    expect(progress).toHaveBeenLastCalledWith(1000, 1000);
  });

  it('hashes an empty file (progress needs a positive total)', async () => {
    const progress = vi.fn<(completed: number, total: number) => void>();
    const output = await runTask({ file: new Blob([]) }, { progress });
    expect(output.size).toBe(0);
    expect(output.digests['SHA-256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('reads a big file piece by piece and reports progress after each piece', async () => {
    const data = noise(CHUNK_SIZE * 2 + 123);
    const progress = vi.fn<(completed: number, total: number) => void>();
    const output = await runTask({ file: new Blob([data]) }, { progress });
    expect(output.digests['SHA-256']).toBe(createHash('sha256').update(data).digest('hex'));
    expect(progress.mock.calls.map(([done]) => done)).toEqual([
      CHUNK_SIZE,
      CHUNK_SIZE * 2,
      data.length,
      data.length,
    ]);
    expect(progress.mock.calls.every(([, total]) => total === data.length)).toBe(true);
  }, 60_000);
});

describe('the worker', () => {
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
    void pool.run({ file: new Blob(['x']) }).catch(() => undefined);
    void pool.run({ file: new Blob(['y']) }).catch(() => undefined);
    pool.terminate();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/hash/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });

  it('answers a run request with the digests and refuses input it cannot hash', async () => {
    const listeners: ((event: { data: unknown; origin: string }) => void)[] = [];
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
      type: string,
      listener: (event: { data: unknown; origin: string }) => void,
    ) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    }) as typeof globalThis.addEventListener);
    const replies: unknown[] = [];
    vi.spyOn(globalThis, 'postMessage').mockImplementation(((message: unknown) => {
      replies.push(message);
    }) as typeof globalThis.postMessage);

    await import('../../src/tools/hash/worker.ts');
    expect(listeners).toHaveLength(1);
    listeners[0]?.({
      data: { type: 'run', id: 1, input: { file: new Blob(['abc']) } },
      origin: '',
    });
    listeners[0]?.({ data: { type: 'run', id: 2, input: { file: 'not a file' } }, origin: '' });
    await vi.waitFor(() => {
      expect(
        replies.filter((reply) => (reply as { type: string }).type !== 'progress'),
      ).toHaveLength(2);
    });
    const result = replies.find(
      (reply) =>
        (reply as { id: number; type: string }).id === 1 &&
        (reply as { type: string }).type === 'result',
    ) as {
      output: { digests: Record<string, string> };
    };
    expect(result.output.digests['SHA-1']).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(replies).toContainEqual({
      type: 'error',
      id: 2,
      message: 'the worker received input it cannot work with',
    });
  });
});
