import { describe, expect, it } from 'vitest';
import {
  createWorkerPool,
  progressFraction,
  serveWorker,
  type Progress,
  type WorkerLike,
} from '../src/index.ts';
import { isProgress, isReply, isRunRequest } from '../src/worker-protocol.ts';
import { FakeScope, flush } from './fake-worker.ts';

describe('serveWorker', () => {
  it('answers a run request with the result', async () => {
    const scope = new FakeScope();
    serveWorker<number, number>((input) => input * 2, { scope });
    scope.deliver({ type: 'run', id: 3, input: 21 });
    await flush();
    expect(scope.posted).toEqual([
      { message: { type: 'result', id: 3, output: 42 }, transfer: undefined },
    ]);
  });

  it('awaits an async handler', async () => {
    const scope = new FakeScope();
    serveWorker<string, string>(async (input) => Promise.resolve(input.toUpperCase()), { scope });
    scope.deliver({ type: 'run', id: 0, input: 'a' });
    await flush();
    expect(scope.posted[0]?.message).toEqual({ type: 'result', id: 0, output: 'A' });
  });

  it('reports progress before the result', async () => {
    const scope = new FakeScope();
    serveWorker<number, string>(
      (pages, { progress }) => {
        for (let page = 1; page <= pages; page += 1) {
          progress(page, pages);
        }
        return 'done';
      },
      { scope },
    );
    scope.deliver({ type: 'run', id: 1, input: 2 });
    await flush();
    expect(scope.posted.map((entry) => entry.message)).toEqual([
      { type: 'progress', id: 1, progress: { completed: 1, total: 2 } },
      { type: 'progress', id: 1, progress: { completed: 2, total: 2 } },
      { type: 'result', id: 1, output: 'done' },
    ]);
  });

  it.each([
    [-1, 5],
    [6, 5],
    [1, 0],
    [Number.NaN, 5],
    [1, Number.POSITIVE_INFINITY],
  ])('refuses progress %j of %j: the handler gets a RangeError, the job fails', async (a, b) => {
    const scope = new FakeScope();
    serveWorker<undefined, string>(
      (_input, { progress }) => {
        progress(a, b);
        return 'unreachable';
      },
      { scope },
    );
    scope.deliver({ type: 'run', id: 0, input: undefined });
    await flush();
    expect(scope.posted).toHaveLength(1);
    const reply = scope.posted[0]?.message as { type: string; message: string };
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('is not 0 <= completed <= total with total > 0');
  });

  it('accepts progress at both ends of the range', async () => {
    const scope = new FakeScope();
    serveWorker<undefined, string>(
      (_input, { progress }) => {
        progress(0, 1);
        progress(1, 1);
        return 'ok';
      },
      { scope },
    );
    scope.deliver({ type: 'run', id: 0, input: undefined });
    await flush();
    expect(scope.posted).toHaveLength(3);
  });

  it.each([
    [new Error('bad file'), 'bad file'],
    [new RangeError(''), 'RangeError'],
    ['plain text', 'plain text'],
    ['', 'the task failed'],
    [42, 'the task failed'],
    [undefined, 'the task failed'],
  ])('turns the thrown %j into the error message %j', async (thrown, message) => {
    const scope = new FakeScope();
    serveWorker<undefined, string>(
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- any thrown value must be reported
        throw thrown;
      },
      { scope },
    );
    scope.deliver({ type: 'run', id: 5, input: undefined });
    await flush();
    expect(scope.posted).toEqual([
      { message: { type: 'error', id: 5, message }, transfer: undefined },
    ]);
  });

  it('turns a rejected promise into an error reply and keeps serving', async () => {
    const scope = new FakeScope();
    let calls = 0;
    serveWorker<undefined, string>(
      async () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('first fails')) : Promise.resolve('second');
      },
      { scope },
    );
    scope.deliver({ type: 'run', id: 0, input: undefined });
    scope.deliver({ type: 'run', id: 1, input: undefined });
    await flush();
    expect(scope.posted.map((entry) => entry.message)).toEqual([
      { type: 'error', id: 0, message: 'first fails' },
      { type: 'result', id: 1, output: 'second' },
    ]);
  });

  it('hands the output buffers to the page instead of copying them', async () => {
    const scope = new FakeScope();
    const buffer = new ArrayBuffer(4);
    serveWorker<undefined, ArrayBuffer>(() => buffer, { scope, transfer: (output) => [output] });
    scope.deliver({ type: 'run', id: 0, input: undefined });
    await flush();
    expect(scope.posted[0]?.transfer).toEqual([buffer]);
  });

  it('reports a failing transfer list as the job error', async () => {
    const scope = new FakeScope();
    serveWorker<undefined, string>(() => 'x', {
      scope,
      transfer: () => {
        throw new Error('not transferable');
      },
    });
    scope.deliver({ type: 'run', id: 0, input: undefined });
    await flush();
    expect(scope.posted).toEqual([
      { message: { type: 'error', id: 0, message: 'not transferable' }, transfer: undefined },
    ]);
  });

  it.each([
    null,
    'run',
    { type: 'run' },
    { type: 'run', id: -1, input: 1 },
    { type: 'other', id: 0, input: 1 },
    undefined,
  ])('ignores a message that is not a run request (%j)', async (data) => {
    const scope = new FakeScope();
    let called = false;
    serveWorker<undefined, string>(
      () => {
        called = true;
        return 'x';
      },
      { scope },
    );
    scope.deliver(data);
    await flush();
    expect(called).toBe(false);
    expect(scope.posted).toEqual([]);
  });

  it('answers a message with an empty origin (a worker hears its parent) and only that', async () => {
    const scope = new FakeScope();
    serveWorker<number, number>((input) => input + 1, { scope });
    scope.deliver({ type: 'run', id: 0, input: 1 }, '');
    scope.deliver({ type: 'run', id: 1, input: 1 }, 'https://example.org');
    scope.deliver({ type: 'run', id: 2, input: 1 }, 'null');
    await flush();
    expect(scope.posted.map((entry) => entry.message)).toEqual([
      { type: 'result', id: 0, output: 2 },
    ]);
  });

  it('lets a job through when its input is accepted and refuses it otherwise', async () => {
    const scope = new FakeScope();
    let calls = 0;
    serveWorker<number, number>(
      (input) => {
        calls += 1;
        return input + 1;
      },
      { scope, accepts: (input): input is number => typeof input === 'number' },
    );
    scope.deliver({ type: 'run', id: 0, input: 1 });
    scope.deliver({ type: 'run', id: 1, input: 'one' });
    await flush();
    expect(calls).toBe(1);
    // Replies of different jobs may come in either order; each carries its job id.
    const replies = scope.posted
      .map((entry) => entry.message as { id: number })
      .toSorted((x, y) => x.id - y.id);
    expect(replies).toEqual([
      { type: 'result', id: 0, output: 2 },
      { type: 'error', id: 1, message: 'the worker received input it cannot work with' },
    ]);
  });

  it('uses the global scope when none is given', () => {
    const original = globalThis as unknown as Record<string, unknown>;
    const added: unknown[] = [];
    const saved = { addEventListener: original['addEventListener'] };
    original['addEventListener'] = (type: string, listener: unknown): void => {
      added.push([type, typeof listener]);
    };
    try {
      serveWorker<undefined, string>(() => 'x');
    } finally {
      original['addEventListener'] = saved.addEventListener;
    }
    expect(added).toEqual([['message', 'function']]);
  });
});

describe('the protocol guards', () => {
  it('isRunRequest needs type run, a safe id and an input', () => {
    expect(isRunRequest({ type: 'run', id: 0, input: null })).toBe(true);
    expect(isRunRequest({ type: 'run', id: 0, input: undefined })).toBe(true);
    expect(isRunRequest({ type: 'run', id: 0 })).toBe(false);
    expect(isRunRequest({ type: 'run', id: 2 ** 53, input: 1 })).toBe(false);
    expect(isRunRequest(null)).toBe(false);
    expect(isRunRequest('run')).toBe(false);
  });

  it('isReply accepts the three reply kinds and nothing else', () => {
    expect(isReply({ type: 'result', id: 0, output: undefined })).toBe(true);
    expect(isReply({ type: 'error', id: 1, message: '' })).toBe(true);
    expect(isReply({ type: 'progress', id: 2, progress: { completed: 0, total: 1 } })).toBe(true);
    expect(isReply({ type: 'error', id: 1, message: 5 })).toBe(false);
    expect(isReply(undefined)).toBe(false);
  });

  it('isProgress checks the range on both sides', () => {
    expect(isProgress({ completed: 0, total: 1 })).toBe(true);
    expect(isProgress({ completed: 1, total: 1 })).toBe(true);
    expect(isProgress({ completed: 1.5, total: 2 })).toBe(true);
    expect(isProgress({ completed: -0.1, total: 1 })).toBe(false);
    expect(isProgress({ completed: 1.1, total: 1 })).toBe(false);
    expect(isProgress({ completed: 0, total: 0 })).toBe(false);
    expect(isProgress({ completed: '1', total: 2 })).toBe(false);
    expect(isProgress(null)).toBe(false);
    expect(isProgress(3)).toBe(false);
  });

  it('progressFraction is completed over total', () => {
    expect(progressFraction({ completed: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ completed: 4, total: 4 })).toBe(1);
  });
});

describe('pool and serveWorker together (a loopback worker that clones every message)', () => {
  /** A worker whose other end is a real `serveWorker`, joined by structured cloning. */
  function loopback<I, O>(
    handler: Parameters<typeof serveWorker<I, O>>[0],
  ): { readonly create: () => WorkerLike; readonly stopped: () => number } {
    let stopped = 0;
    return {
      stopped: (): number => stopped,
      create: (): WorkerLike => {
        const scope = new FakeScope();
        const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
        let alive = true;
        serveWorker<I, O>(handler, {
          scope: {
            postMessage: (message): void => {
              const copy: unknown = structuredClone(message);
              queueMicrotask(() => {
                if (alive) {
                  for (const listener of listeners['message'] ?? []) {
                    listener({ data: copy });
                  }
                }
              });
            },
            addEventListener: (type, listener): void => {
              scope.addEventListener(type, listener);
            },
          },
        });
        return {
          postMessage: (message): void => {
            const copy: unknown = structuredClone(message);
            queueMicrotask(() => {
              if (alive) {
                scope.deliver(copy);
              }
            });
          },
          terminate: (): void => {
            alive = false;
            stopped += 1;
          },
          addEventListener: (type, listener): void => {
            (listeners[type] ??= []).push(listener);
          },
        };
      },
    };
  }

  it('runs jobs end to end with progress', async () => {
    const worker = loopback<number, number>(async (count, { progress }) => {
      let sum = 0;
      for (let step = 1; step <= count; step += 1) {
        sum += step;
        progress(step, count);
        await Promise.resolve();
      }
      return sum;
    });
    const pool = createWorkerPool<number, number>({ create: worker.create, size: 2 });
    const seen: Progress[] = [];
    const [a, b] = await Promise.all([
      pool.run(4, { onProgress: (p) => seen.push(p) }),
      pool.run(10),
    ]);
    expect([a, b]).toEqual([10, 55]);
    expect(seen.map((p) => p.completed)).toEqual([1, 2, 3, 4]);
    pool.terminate();
    expect(worker.stopped()).toBe(2);
  });

  it('rejects a job whose handler throws and still serves the next one', async () => {
    const worker = loopback<string, string>((input) => {
      if (input === 'bad') {
        throw new Error('cannot read this file');
      }
      return input;
    });
    const pool = createWorkerPool<string, string>({ create: worker.create, size: 1 });
    await expect(pool.run('bad')).rejects.toThrow('cannot read this file');
    await expect(pool.run('good')).resolves.toBe('good');
    expect(worker.stopped()).toBe(0);
    pool.terminate();
  });

  it('cancels a running job by stopping its worker', async () => {
    const worker = loopback<string, string>(() => new Promise<string>(() => undefined));
    const pool = createWorkerPool<string, string>({ create: worker.create, size: 1 });
    const controller = new AbortController();
    const job = pool.run('never', { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.stopped()).toBe(1);
    pool.terminate();
  });
});
