import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/diff/pool.ts';
import { isInput, runTask, type Input } from '../../src/tools/diff/task.ts';

const input: Input = {
  before: 'a\nb\n',
  after: 'a\nc\n',
  unit: 'lines',
  ignoreWhitespace: false,
  context: 3,
};

describe('diff worker', () => {
  it('reports its progress and returns the result', () => {
    const progress = vi.fn();
    const output = runTask(input, { progress });
    expect(output.unit).toBe('lines');
    expect(progress.mock.calls).toEqual([
      [0, 1],
      [1, 1],
    ]);
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
    void pool.run(input).catch(() => undefined);
    void pool.run(input).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/diff/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});

describe('the input guard of the worker', () => {
  it('accepts a well-formed input, with or without a budget', () => {
    expect(isInput(input)).toBe(true);
    expect(isInput({ ...input, unit: 'words', context: -1, budgetMs: 50 })).toBe(true);
    expect(isInput({ ...input, budgetMs: undefined })).toBe(true);
  });

  it.each([
    null,
    'text',
    42,
    {},
    { ...input, before: 1 },
    { ...input, after: null },
    { ...input, unit: 'chars' },
    { ...input, ignoreWhitespace: 'yes' },
    { ...input, context: '3' },
    { ...input, context: 1.5 },
    { ...input, context: -2 },
    { ...input, budgetMs: 0 },
    { ...input, budgetMs: '5' },
  ])('refuses %j', (value) => {
    expect(isInput(value)).toBe(false);
  });
});
