import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerPool,
  defaultPoolSize,
  MAX_DEFAULT_POOL_SIZE,
  PoolTerminatedError,
  WorkerCrashError,
  WorkerPool,
  WorkerTaskError,
  type Progress,
} from '../src/index.ts';
import { Factory, flush, type FakeWorker } from './fake-worker.ts';
import { random } from './fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function pool(size: number, factory: Factory): WorkerPool<string, string> {
  return createWorkerPool<string, string>({ create: factory.create, size });
}

function worker(factory: Factory, index: number): FakeWorker {
  const found = factory.workers[index];
  if (found === undefined) {
    throw new Error(`worker ${String(index)} was not started`);
  }
  return found;
}

function result(target: FakeWorker, output: unknown): void {
  target.reply({ type: 'result', id: target.lastId(), output });
}

/** Settles into a value the test can inspect, so a rejection is never unhandled. */
function track<T>(promise: Promise<T>): {
  readonly state: () => 'pending' | 'resolved' | 'rejected';
  readonly value: () => unknown;
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let value: unknown;
  promise.then(
    (output) => {
      state = 'resolved';
      value = output;
    },
    (error: unknown) => {
      state = 'rejected';
      value = error;
    },
  );
  return { state: (): typeof state => state, value: (): unknown => value };
}

describe('defaultPoolSize', () => {
  it.each([
    [undefined, 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [0, 2],
    [-3, 2],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 4],
    [8.9, 4],
    [64, 4],
  ])('cores %j gives %j', (cores, expected) => {
    expect(defaultPoolSize(cores)).toBe(expected);
  });

  it('never exceeds the maximum', () => {
    for (let cores = 0; cores < 200; cores += 1) {
      const size = defaultPoolSize(cores);
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(MAX_DEFAULT_POOL_SIZE);
    }
  });
});

describe('WorkerPool construction', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects the size %j', (size) => {
    expect(() => new WorkerPool({ create: new Factory().create, size })).toThrow(
      new RangeError(`the pool size must be a whole number of at least 1, got ${String(size)}`),
    );
  });

  it('takes the size from the core count when none is given', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 6 });
    expect(new WorkerPool({ create: new Factory().create }).size).toBe(4);
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    expect(new WorkerPool({ create: new Factory().create }).size).toBe(1);
  });

  it('falls back to two when the core count is unknown', () => {
    vi.stubGlobal('navigator', undefined);
    expect(new WorkerPool({ create: new Factory().create }).size).toBe(2);
  });

  it('starts no worker until a job needs one', () => {
    const factory = new Factory();
    const instance = pool(3, factory);
    expect(factory.workers).toHaveLength(0);
    expect(instance.workers).toBe(0);
    expect(instance.queued).toBe(0);
    expect(instance.running).toBe(0);
  });
});

describe('running jobs', () => {
  it('sends the request, transfers buffers and resolves with the output', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const buffer = new ArrayBuffer(8);
    const done = instance.run('hello', { transfer: [buffer] });
    const first = worker(factory, 0);
    expect(first.sent).toEqual([
      { message: { type: 'run', id: 0, input: 'hello' }, transfer: [buffer] },
    ]);
    result(first, 'HELLO');
    await expect(done).resolves.toBe('HELLO');
    expect(instance.running).toBe(0);
  });

  it('gives every job its own id', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const a = instance.run('a');
    result(worker(factory, 0), 'A');
    await a;
    const b = instance.run('b');
    expect(worker(factory, 0).lastId()).toBe(1);
    result(worker(factory, 0), 'B');
    await b;
  });

  it('reuses an idle worker instead of starting another', async () => {
    const factory = new Factory();
    const instance = pool(3, factory);
    const a = instance.run('a');
    result(worker(factory, 0), 'A');
    await a;
    const b = instance.run('b');
    expect(factory.workers).toHaveLength(1);
    result(worker(factory, 0), 'B');
    await b;
  });

  it('starts workers up to the size, then queues in first-in-first-out order', async () => {
    const factory = new Factory();
    const instance = pool(2, factory);
    const jobs = ['a', 'b', 'c', 'd'].map((input) => instance.run(input));
    expect(factory.workers).toHaveLength(2);
    expect(instance.workers).toBe(2);
    expect(instance.running).toBe(2);
    expect(instance.queued).toBe(2);

    result(worker(factory, 1), 'B');
    await jobs[1];
    // The freed worker takes the oldest waiting job.
    expect(worker(factory, 1).sent.map((s) => (s.message as { input: string }).input)).toEqual([
      'b',
      'c',
    ]);
    expect(instance.queued).toBe(1);
    result(worker(factory, 0), 'A');
    await jobs[0];
    expect(worker(factory, 0).sent.map((s) => (s.message as { input: string }).input)).toEqual([
      'a',
      'd',
    ]);
    result(worker(factory, 1), 'C');
    result(worker(factory, 0), 'D');
    await expect(Promise.all(jobs)).resolves.toEqual(['A', 'B', 'C', 'D']);
    expect(factory.workers).toHaveLength(2);
  });

  it('reports progress to the job that asked and nobody else', async () => {
    const factory = new Factory();
    const instance = pool(2, factory);
    const seenA: Progress[] = [];
    const seenB: Progress[] = [];
    const a = instance.run('a', { onProgress: (p) => seenA.push(p) });
    const b = instance.run('b', { onProgress: (p) => seenB.push(p) });
    worker(factory, 0).reply({
      type: 'progress',
      id: worker(factory, 0).lastId(),
      progress: { completed: 1, total: 4 },
    });
    worker(factory, 1).reply({
      type: 'progress',
      id: worker(factory, 1).lastId(),
      progress: { completed: 3, total: 3 },
    });
    expect(seenA).toEqual([{ completed: 1, total: 4 }]);
    expect(seenB).toEqual([{ completed: 3, total: 3 }]);
    expect(instance.running).toBe(2);
    result(worker(factory, 0), 'A');
    result(worker(factory, 1), 'B');
    await Promise.all([a, b]);
  });

  it('works without a progress callback', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const done = instance.run('a');
    worker(factory, 0).reply({
      type: 'progress',
      id: 0,
      progress: { completed: 0, total: 1 },
    });
    result(worker(factory, 0), 'A');
    await expect(done).resolves.toBe('A');
  });

  it('rejects with a WorkerTaskError when the handler failed and keeps the worker', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const failed = instance.run('bad');
    worker(factory, 0).reply({ type: 'error', id: 0, message: 'not a PDF' });
    await expect(failed).rejects.toThrow(new WorkerTaskError('not a PDF'));
    await expect(failed).rejects.toMatchObject({ name: 'WorkerTaskError' });
    expect(worker(factory, 0).terminated).toBe(false);
    const next = instance.run('good');
    expect(factory.workers).toHaveLength(1);
    result(worker(factory, 0), 'ok');
    await expect(next).resolves.toBe('ok');
  });

  it('allows an undefined output', async () => {
    const factory = new Factory();
    const instance = createWorkerPool<string, undefined>({ create: factory.create, size: 1 });
    const done = instance.run('a');
    result(worker(factory, 0), undefined);
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects a job whose input cannot be sent and keeps the worker for the next one', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const first = instance.run('warm');
    result(worker(factory, 0), 'ok');
    await first;
    worker(factory, 0).failNextPost = new Error('could not be cloned');
    await expect(instance.run('x')).rejects.toThrow('could not be cloned');
    expect(worker(factory, 0).terminated).toBe(false);
    expect(instance.running).toBe(0);
    const next = instance.run('y');
    result(worker(factory, 0), 'Y');
    await expect(next).resolves.toBe('Y');
  });

  it('goes on with the queue after a job could not be sent', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const running = instance.run('a');
    const doomed = instance.run('b');
    const after = instance.run('c');
    const doomedState = track(doomed);
    worker(factory, 0).failNextPost = new Error('no clone');
    result(worker(factory, 0), 'A');
    await running;
    await flush();
    expect(doomedState.state()).toBe('rejected');
    result(worker(factory, 0), 'C');
    await expect(after).resolves.toBe('C');
  });
});

describe('workers that fail', () => {
  it('rejects the running job when the worker raises an error and starts a new worker later', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    const queued = instance.run('b');
    const lostState = track(lost);
    worker(factory, 0).emit('error', { message: 'out of memory' });
    await flush();
    expect(lostState.state()).toBe('rejected');
    expect(lostState.value()).toEqual(new WorkerCrashError('the worker failed: out of memory'));
    expect((lostState.value() as Error).name).toBe('WorkerCrashError');
    expect(worker(factory, 0).terminated).toBe(true);
    // The waiting job runs on a fresh worker.
    expect(factory.workers).toHaveLength(2);
    result(worker(factory, 1), 'B');
    await expect(queued).resolves.toBe('B');
  });

  it('names an unknown failure', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    worker(factory, 0).emit('error', {});
    await expect(lost).rejects.toThrow('the worker failed: unknown error');
  });

  it('treats a message that cannot be deserialised as a crash', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    worker(factory, 0).emit('messageerror');
    await expect(lost).rejects.toThrow('the worker sent a message that could not be read');
    expect(worker(factory, 0).terminated).toBe(true);
  });

  it('drops an idle worker that raises an error without failing anything', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const first = instance.run('a');
    result(worker(factory, 0), 'A');
    await first;
    worker(factory, 0).emit('error', { message: 'late' });
    expect(instance.workers).toBe(0);
    expect(worker(factory, 0).terminated).toBe(true);
    const next = instance.run('b');
    expect(factory.workers).toHaveLength(2);
    result(worker(factory, 1), 'B');
    await expect(next).resolves.toBe('B');
  });

  it('ignores a second error from a worker that is already gone', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    const next = instance.run('b');
    worker(factory, 0).emit('error', { message: 'one' });
    worker(factory, 0).emit('error', { message: 'two' });
    await expect(lost).rejects.toThrow('the worker failed: one');
    expect(factory.workers).toHaveLength(2);
    result(worker(factory, 1), 'B');
    await next;
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['an unknown type', { type: 'nope', id: 0 }],
    ['a result without output', { type: 'result', id: 0 }],
    ['a progress without a progress object', { type: 'progress', id: 0 }],
    ['a progress beyond total', { type: 'progress', id: 0, progress: { completed: 2, total: 1 } }],
    ['a progress with total 0', { type: 'progress', id: 0, progress: { completed: 0, total: 0 } }],
    ['an error without a message', { type: 'error', id: 0 }],
    ['a negative id', { type: 'result', id: -1, output: 'x' }],
    ['a fractional id', { type: 'result', id: 0.5, output: 'x' }],
    ['the id of another job', { type: 'result', id: 7, output: 'x' }],
  ])('treats %s as a protocol error and replaces the worker', async (_name, data) => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    worker(factory, 0).reply(data);
    await expect(lost).rejects.toThrow('the worker broke the message protocol');
    expect(worker(factory, 0).terminated).toBe(true);
    expect(instance.workers).toBe(0);
  });

  it('treats a message from an idle worker as a protocol error', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const first = instance.run('a');
    result(worker(factory, 0), 'A');
    await first;
    worker(factory, 0).reply({ type: 'result', id: 0, output: 'again' });
    expect(worker(factory, 0).terminated).toBe(true);
    expect(instance.workers).toBe(0);
  });

  it('rejects the job when a worker cannot be started, then tries the next job', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    factory.failCreate = new Error('blocked by CSP');
    const first = instance.run('a');
    await expect(first).rejects.toThrow('could not start a worker: blocked by CSP');
    await expect(first).rejects.toBeInstanceOf(WorkerCrashError);
    factory.failCreate = undefined;
    const second = instance.run('b');
    result(worker(factory, 0), 'B');
    await expect(second).resolves.toBe('B');
  });

  it('fails every queued job when no worker can be started', async () => {
    const factory = new Factory();
    factory.failCreate = new Error('no workers here');
    const instance = pool(2, factory);
    const jobs = [instance.run('a'), instance.run('b')];
    await expect(jobs[0]).rejects.toThrow('could not start a worker: no workers here');
    await expect(jobs[1]).rejects.toThrow('could not start a worker: no workers here');
    expect(instance.queued).toBe(0);
  });

  it('describes a start failure that is not an Error', async () => {
    const instance = createWorkerPool<string, string>({
      create: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the pool must cope with any thrown value
        throw 'plain text';
      },
      size: 1,
    });
    await expect(instance.run('a')).rejects.toThrow('could not start a worker: plain text');
    const empty = createWorkerPool<string, string>({
      create: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the pool must cope with any thrown value
        throw 42;
      },
      size: 1,
    });
    await expect(empty.run('a')).rejects.toThrow('could not start a worker: unknown error');
  });
});

describe('cancelling', () => {
  it('rejects at once when the signal is already aborted, without starting a worker', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    controller.abort();
    await expect(instance.run('a', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(factory.workers).toHaveLength(0);
  });

  it('wraps a reason that is not an Error in an AbortError that carries it', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    controller.abort('just stop');
    const error: unknown = await instance
      .run('a', { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect((error as Error).cause).toBe('just stop');

    const running = new AbortController();
    const job = track(instance.run('b', { signal: running.signal }));
    running.abort(42);
    await flush();
    expect((job.value() as Error).cause).toBe(42);
  });

  it('rejects with the reason given to abort()', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    await expect(instance.run('a', { signal: controller.signal })).rejects.toThrow(
      'user cancelled',
    );
  });

  it('removes a waiting job from the queue without touching a worker', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const first = instance.run('a');
    const controller = new AbortController();
    const waiting = instance.run('b', { signal: controller.signal });
    const waitingState = track(waiting);
    const third = instance.run('c');
    controller.abort();
    await flush();
    expect(waitingState.state()).toBe('rejected');
    expect((waitingState.value() as Error).name).toBe('AbortError');
    expect(instance.queued).toBe(1);
    expect(worker(factory, 0).terminated).toBe(false);
    result(worker(factory, 0), 'A');
    await first;
    expect(worker(factory, 0).sent).toHaveLength(2);
    expect((worker(factory, 0).sent[1]?.message as { input: string }).input).toBe('c');
    result(worker(factory, 0), 'C');
    await expect(third).resolves.toBe('C');
  });

  it('stops the worker of a running job, rejects it and starts a fresh worker for the queue', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const running = instance.run('a', { signal: controller.signal });
    const runningState = track(running);
    const queued = instance.run('b');
    controller.abort(new Error('stop'));
    await flush();
    expect(runningState.state()).toBe('rejected');
    expect((runningState.value() as Error).message).toBe('stop');
    expect(worker(factory, 0).terminated).toBe(true);
    expect(factory.workers).toHaveLength(2);
    expect(instance.workers).toBe(1);
    result(worker(factory, 1), 'B');
    await expect(queued).resolves.toBe('B');
  });

  it('ignores a message that was already on its way from the stopped worker', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const running = instance.run('a', { signal: controller.signal });
    const state = track(running);
    controller.abort();
    await flush();
    result(worker(factory, 0), 'late');
    await flush();
    expect(state.state()).toBe('rejected');
  });

  it('does nothing when the signal aborts after the job finished', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const done = instance.run('a', { signal: controller.signal });
    result(worker(factory, 0), 'A');
    await done;
    controller.abort();
    expect(worker(factory, 0).terminated).toBe(false);
    expect(instance.workers).toBe(1);
  });

  it('does nothing when the signal aborts after the job failed', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const failed = instance.run('a', { signal: controller.signal });
    worker(factory, 0).reply({ type: 'error', id: 0, message: 'x' });
    await expect(failed).rejects.toBeInstanceOf(WorkerTaskError);
    controller.abort();
    expect(worker(factory, 0).terminated).toBe(false);
  });

  it('one abort cancels only its own job', async () => {
    const factory = new Factory();
    const instance = pool(2, factory);
    const controller = new AbortController();
    const a = instance.run('a', { signal: controller.signal });
    const b = instance.run('b');
    const aState = track(a);
    controller.abort();
    await flush();
    expect(aState.state()).toBe('rejected');
    expect(worker(factory, 1).terminated).toBe(false);
    result(worker(factory, 1), 'B');
    await expect(b).resolves.toBe('B');
  });
});

describe('terminating', () => {
  it('stops every worker and rejects running and waiting jobs', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const running = track(instance.run('a'));
    const waiting = track(instance.run('b'));
    instance.terminate();
    await flush();
    expect(running.state()).toBe('rejected');
    expect(waiting.state()).toBe('rejected');
    expect(running.value()).toBeInstanceOf(PoolTerminatedError);
    expect((running.value() as Error).message).toBe('the worker pool was terminated');
    expect(worker(factory, 0).terminated).toBe(true);
    expect(instance.workers).toBe(0);
    expect(instance.queued).toBe(0);
  });

  it('refuses new jobs afterwards', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    instance.terminate();
    await expect(instance.run('a')).rejects.toBeInstanceOf(PoolTerminatedError);
    expect(factory.workers).toHaveLength(0);
  });

  it('can be called twice', () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    void track(instance.run('a'));
    instance.terminate();
    expect(() => {
      instance.terminate();
    }).not.toThrow();
  });

  it('ignores replies that arrive after it and does not resolve a rejected job', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const state = track(instance.run('a'));
    instance.terminate();
    result(worker(factory, 0), 'late');
    await flush();
    expect(state.state()).toBe('rejected');
  });

  it('removes the abort listener of the jobs it rejects', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const state = track(instance.run('a', { signal: controller.signal }));
    instance.terminate();
    await flush();
    controller.abort();
    expect(state.value()).toBeInstanceOf(PoolTerminatedError);
  });
});

describe('random schedules (property)', () => {
  it('settle every job exactly once and never exceed the size', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const next = random(seed);
      const factory = new Factory();
      const size = 1 + Math.floor(next() * 3);
      const instance = pool(size, factory);
      const jobs: { readonly track: ReturnType<typeof track>; controller: AbortController }[] = [];
      let settledTwice = false;

      for (let step = 0; step < 120; step += 1) {
        const roll = next();
        if (roll < 0.35) {
          const controller = new AbortController();
          const promise = instance.run(`job${String(step)}`, { signal: controller.signal });
          let count = 0;
          void promise.then(
            () => (count += 1),
            () => (count += 1),
          );
          jobs.push({ track: track(promise), controller });
          void Promise.resolve().then(() => {
            if (count > 1) {
              settledTwice = true;
            }
          });
        } else if (roll < 0.6) {
          const busy = factory.workers.filter((w) => !w.terminated && w.sent.length > 0);
          const target = busy[Math.floor(next() * busy.length)];
          if (target !== undefined) {
            const last = target.sent.at(-1)?.message as { id: number };
            target.reply({ type: 'result', id: last.id, output: 'done' });
          }
        } else if (roll < 0.7) {
          const alive = factory.workers.filter((w) => !w.terminated);
          alive[Math.floor(next() * alive.length)]?.emit('error', { message: 'boom' });
        } else if (roll < 0.85) {
          jobs[Math.floor(next() * jobs.length)]?.controller.abort();
        }
        expect(instance.workers).toBeLessThanOrEqual(size);
        expect(instance.running).toBeLessThanOrEqual(instance.workers);
        expect(instance.running + instance.queued).toBeGreaterThanOrEqual(0);
        await flush();
      }

      instance.terminate();
      await flush();
      expect(instance.workers).toBe(0);
      expect(instance.queued).toBe(0);
      expect(settledTwice).toBe(false);
      for (const job of jobs) {
        expect(job.track.state()).not.toBe('pending');
      }
      expect(factory.workers.every((w) => w.terminated)).toBe(true);
    }
  });
});
