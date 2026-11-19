import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/json-yaml-xml/pool.ts';
import { isInput, runTask, type Input } from '../../src/tools/json-yaml-xml/task.ts';

const input: Input = {
  from: 'json',
  to: 'yaml',
  text: '{"a":1}',
  indent: 2,
  sortKeys: false,
  rootName: 'root',
  typed: false,
  declaration: false,
};

describe('json-yaml-xml worker', () => {
  it('reports its progress and returns the result', () => {
    const progress = vi.fn();
    expect(runTask(input, { progress })).toEqual({ ok: true, text: 'a: 1\n', notes: [] });
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('answers a bad document as a result, not as a crash', () => {
    const output = runTask({ ...input, text: '{' }, { progress: vi.fn() });
    expect(output).toMatchObject({ ok: false, error: { where: 'read', format: 'json' } });
  });

  it('checks what the page sends', () => {
    expect(isInput(input)).toBe(true);
    expect(isInput({ ...input, from: 'csv' })).toBe(false);
  });

  it('starts one worker from worker.ts as a module, so that it can be stopped', () => {
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
    void pool.run(input).catch(() => undefined);
    void pool.run(input).catch(() => undefined);
    expect(pool.size).toBe(1);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/json-yaml-xml/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});
