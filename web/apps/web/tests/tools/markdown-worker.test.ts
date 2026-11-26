import { describe, expect, it, vi } from 'vitest';
import { isInput, markdownToHtml, runTask } from '../../src/tools/markdown/parse.ts';
import { createPool } from '../../src/tools/markdown/pool.ts';
import { talkToWorker } from '../worker-entry.ts';

describe('markdown worker', () => {
  it('turns Markdown into HTML, unclean as it is: the page cleans it', () => {
    expect(markdownToHtml('**a** <b>x</b>')).toBe('<p><strong>a</strong> <b>x</b></p>\n');
    expect(runTask({ source: '# T' })).toBe('<h1>T</h1>\n');
    expect(markdownToHtml('')).toBe('');
  });

  it('checks what the page sends', () => {
    expect(isInput({ source: 'x' })).toBe(true);
    expect(isInput({ source: 1 })).toBe(false);
    expect(isInput({})).toBe(false);
    expect(isInput(null)).toBe(false);
    expect(isInput('x')).toBe(false);
    expect(isInput(undefined)).toBe(false);
    expect(isInput(5)).toBe(false);
  });

  it('answers the requests of the page from worker.ts: Markdown in, HTML out, anything else refused', async () => {
    const replies = await talkToWorker(
      () => import('../../src/tools/markdown/worker.ts'),
      [
        { type: 'run', id: 1, input: { source: '# T' } },
        { type: 'run', id: 2, input: { source: 5 } },
      ],
    );
    expect(replies).toContainEqual({ type: 'result', id: 1, output: '<h1>T</h1>\n' });
    expect(replies).toContainEqual({
      type: 'error',
      id: 2,
      message: 'the worker received input it cannot work with',
    });
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
    void pool.run({ source: 'x' }).catch(() => undefined);
    expect(pool.size).toBe(1);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/markdown/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});
