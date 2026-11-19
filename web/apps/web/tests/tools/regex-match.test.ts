import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLAGS,
  MAX_MATCHES,
  compileError,
  findMatches,
  isInput,
  runTask,
  type Input,
  type Output,
} from '../../src/tools/regex/match.ts';
import { createPool } from '../../src/tools/regex/pool.ts';

function find(pattern: string, text: string, flags = 'g', maxMatches = MAX_MATCHES): Output {
  return findMatches({ pattern, flags, text, maxMatches });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('findMatches', () => {
  it('finds every match with its position when the g flag is on', () => {
    const { matches, truncated } = find('a+', 'caat aa a');
    expect(matches.map((m) => [m.index, m.text])).toEqual([
      [1, 'aa'],
      [5, 'aa'],
      [8, 'a'],
    ]);
    expect(truncated).toBe(false);
  });

  it('finds only the first match without g', () => {
    const { matches } = find('a+', 'caat aa a', '');
    expect(matches.map((m) => m.text)).toEqual(['aa']);
  });

  it('finds nothing when nothing matches', () => {
    expect(find('z', 'abc')).toEqual({ matches: [], truncated: false });
    expect(find('z', 'abc', '')).toEqual({ matches: [], truncated: false });
  });

  it('lists numbered and named groups, and the groups that did not take part', () => {
    const { matches } = find('(?<year>\\d{4})-(\\d{2})(x)?', 'on 2026-06 and 1999-12x');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      index: 3,
      text: '2026-06',
      groups: ['2026', '06', undefined],
      named: [['year', '2026']],
    });
    expect(matches[1]?.groups).toEqual(['1999', '12', 'x']);
  });

  it('honours the flags', () => {
    expect(find('abc', 'ABC', 'gi').matches).toHaveLength(1);
    expect(find('abc', 'ABC', 'g').matches).toHaveLength(0);
    expect(find('^a', 'a\na', 'gm').matches).toHaveLength(2);
    expect(find('^a', 'a\na', 'g').matches).toHaveLength(1);
    expect(find('a.b', 'a\nb', 'gs').matches).toHaveLength(1);
    expect(find('a.b', 'a\nb', 'g').matches).toHaveLength(0);
  });

  it('does not loop on empty matches: it steps over one character', () => {
    expect(find('x*', 'abc').matches.map((m) => m.index)).toEqual([0, 1, 2, 3]);
    expect(find('', '').matches).toHaveLength(1);
    expect(find('x*', 'abc', '').matches).toHaveLength(1);
  });

  it('steps over a whole code point with u or v, so a surrogate pair is not cut in two', () => {
    const emoji = '😀';
    expect(find('(?:)', emoji, 'gu').matches.map((m) => m.index)).toEqual([0, 2]);
    expect(find('(?:)', emoji, 'gv').matches.map((m) => m.index)).toEqual([0, 2]);
    expect(find('(?:)', emoji, 'g').matches.map((m) => m.index)).toEqual([0, 1, 2]);
    expect(find('(?:)', 'ab', 'gu').matches.map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it('matches consecutively with the sticky flag', () => {
    expect(find('a', 'aab', 'y').matches.map((m) => m.index)).toEqual([0, 1]);
    expect(find('b', 'aab', 'y').matches).toHaveLength(0);
  });

  it('stops at the limit and says there are more', () => {
    const { matches, truncated } = find('a', 'aaaaa', 'g', 3);
    expect(matches).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(find('a', 'aaa', 'g', 3)).toMatchObject({ truncated: false });
    expect(find('a', 'aaa', 'g', 3).matches).toHaveLength(3);
  });

  it('copes with the limit of the page on a long text', () => {
    const { matches, truncated } = find('a', 'a'.repeat(MAX_MATCHES + 50));
    expect(matches).toHaveLength(MAX_MATCHES);
    expect(truncated).toBe(true);
  });

  it('throws for a pattern the browser rejects', () => {
    expect(() => find('(', 'a')).toThrow(SyntaxError);
  });

  it('reports progress when it has a context', () => {
    const progress = vi.fn<(completed: number, total: number) => void>();
    runTask({ pattern: 'a', flags: 'g', text: 'a', maxMatches: 5 }, { progress });
    expect(progress).toHaveBeenCalledWith(1, 1);
  });
});

describe('compileError', () => {
  it('is undefined for a good pattern and flags', () => {
    expect(compileError('a(b)?', 'gimsuy')).toBeUndefined();
    expect(compileError('[\\p{L}--[a-z]]', 'v')).toBeUndefined();
  });

  it('gives the browser message for a bad pattern', () => {
    expect(compileError('(', '')).toMatch(/Invalid regular expression/);
    expect(compileError('[b-a]', '')).toMatch(/Range out of order/);
  });

  it('refuses flags that cannot be combined, and flags that do not exist', () => {
    expect(compileError('a', 'uv')).toMatch(/Invalid flags/);
    expect(compileError('a', 'gg')).toMatch(/Invalid flags/);
    expect(compileError('a', 'x')).toMatch(/Invalid flags/);
  });

  it('knows every flag of the page', () => {
    for (const flag of FLAGS) {
      expect(compileError('a', flag)).toBeUndefined();
    }
  });
});

describe('isInput', () => {
  const good: Input = { pattern: 'a', flags: 'g', text: 'b', maxMatches: 10 };

  it('accepts a complete job', () => {
    expect(isInput(good)).toBe(true);
    expect(isInput({ ...good, text: '' })).toBe(true);
  });

  it('refuses a job with a missing or wrong part', () => {
    expect(isInput(null)).toBe(false);
    expect(isInput('a')).toBe(false);
    expect(isInput({ ...good, pattern: 1 })).toBe(false);
    expect(isInput({ ...good, flags: undefined })).toBe(false);
    expect(isInput({ ...good, text: null })).toBe(false);
    expect(isInput({ ...good, maxMatches: '10' })).toBe(false);
    expect(isInput({ ...good, maxMatches: 0 })).toBe(false);
    expect(isInput({ ...good, maxMatches: 1.5 })).toBe(false);
  });
});

describe('the worker', () => {
  it('starts one worker from worker.ts as a module', () => {
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
    void pool.run({ pattern: 'a', flags: '', text: 'a', maxMatches: 1 }).catch(() => undefined);
    void pool.run({ pattern: 'b', flags: '', text: 'b', maxMatches: 1 }).catch(() => undefined);
    pool.terminate();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/regex/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });

  it('answers a run request with the matches and an error for a bad pattern', async () => {
    const listeners: ((event: { data: unknown; origin: string }) => void)[] = [];
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
      type: string,
      listener: (event: { data: unknown; origin: string }) => void,
    ) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    }) as typeof globalThis.addEventListener);
    const replies: { type: string; id: number; message?: string; output?: unknown }[] = [];
    vi.spyOn(globalThis, 'postMessage').mockImplementation(((message: {
      type: string;
      id: number;
    }) => {
      replies.push(message);
    }) as typeof globalThis.postMessage);

    await import('../../src/tools/regex/worker.ts');
    expect(listeners).toHaveLength(1);
    const job = (id: number, pattern: string): void => {
      listeners[0]?.({
        data: { type: 'run', id, input: { pattern, flags: 'g', text: 'abab', maxMatches: 9 } },
        origin: '',
      });
    };
    job(1, 'ab');
    job(2, '(');
    await vi.waitFor(() => {
      expect(replies.filter((r) => r.type !== 'progress')).toHaveLength(2);
    });
    const result = replies.find((r) => r.id === 1 && r.type === 'result');
    expect((result?.output as { matches: unknown[] }).matches).toHaveLength(2);
    const error = replies.find((r) => r.id === 2 && r.type === 'error');
    expect(error?.message).toMatch(/Invalid regular expression/);
  });
});
