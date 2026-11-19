import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/textops/pool.ts';

describe('textops worker', () => {
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
    const input = { text: 'x', request: null };
    void pool.run(input).catch(() => undefined);
    void pool.run(input).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/textops/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});
