import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/regex/pool.ts';
import { runTask } from '../../src/tools/regex/task.ts';

describe('regex worker', () => {
  it('reports its progress and returns the result', () => {
    const progress = vi.fn();
    expect(runTask({ text: 'hello' }, { progress })).toBe('hello');
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('starts its workers from worker.ts as modules', () => {
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
    void pool.run({ text: 'x' }).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/regex/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});
