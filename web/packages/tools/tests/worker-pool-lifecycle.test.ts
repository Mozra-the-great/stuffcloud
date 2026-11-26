import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerPool,
  PoolTerminatedError,
  WorkerCrashError,
  type WorkerPool,
  WorkerTaskError,
} from '../src/index.ts';
import { Factory, flush, type FakeWorker } from './fake-worker.ts';

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

/** How many `abort` listeners the signal still has: a job that is over must not hold one. */
function listeners(signal: AbortSignal): number {
  return getEventListeners(signal, 'abort').length;
}

describe('the errors of a pool', () => {
  it('have names and messages', () => {
    expect(new PoolTerminatedError().name).toBe('PoolTerminatedError');
    expect(new PoolTerminatedError().message).toBe('the worker pool was terminated');
    expect(new WorkerCrashError('gone').name).toBe('WorkerCrashError');
    expect(new WorkerTaskError('bad').name).toBe('WorkerTaskError');
  });

  it('name a failure that has no text', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const lost = instance.run('a');
    worker(factory, 0).emit('error', { message: '' });
    await expect(lost).rejects.toThrow(new WorkerCrashError('the worker failed: unknown error'));
    const empty = createWorkerPool<string, string>({
      create: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the pool must cope with any thrown value
        throw '';
      },
      size: 1,
    });
    await expect(empty.run('a')).rejects.toThrow('could not start a worker: unknown error');
  });

  it('give a reason that is not an Error a message of its own', async () => {
    const instance = pool(1, new Factory());
    const controller = new AbortController();
    controller.abort('why');
    const error: unknown = await instance
      .run('a', { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('the job was aborted');
  });
});

describe('the abort listener of a job', () => {
  it('is held while the job waits or runs and gone when it returns', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const running = track(instance.run('a', { signal: controller.signal }));
    expect(listeners(controller.signal)).toBe(1);
    const queuedController = new AbortController();
    const queued = track(instance.run('b', { signal: queuedController.signal }));
    expect(listeners(queuedController.signal)).toBe(1);
    result(worker(factory, 0), 'A');
    await flush();
    expect(running.state()).toBe('resolved');
    expect(listeners(controller.signal)).toBe(0);
    expect(queued.state()).toBe('pending');
    expect(listeners(queuedController.signal)).toBe(1);
  });

  it('is gone when the job returns an error', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const failed = track(instance.run('a', { signal: controller.signal }));
    worker(factory, 0).reply({ type: 'error', id: 0, message: 'no' });
    await flush();
    expect(failed.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('is gone when the worker crashes', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const lost = track(instance.run('a', { signal: controller.signal }));
    worker(factory, 0).emit('error', { message: 'boom' });
    await flush();
    expect(lost.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('is gone when the input cannot be sent', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const warm = instance.run('warm');
    result(worker(factory, 0), 'ok');
    await warm;
    worker(factory, 0).failNextPost = new Error('no clone');
    const controller = new AbortController();
    const refused = track(instance.run('x', { signal: controller.signal }));
    await flush();
    expect(refused.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('is gone when no worker can be started', async () => {
    const factory = new Factory();
    factory.failCreate = new Error('blocked');
    const instance = pool(1, factory);
    const controller = new AbortController();
    const refused = track(instance.run('x', { signal: controller.signal }));
    await flush();
    expect(refused.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('is gone when a running job is cancelled', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const cancelled = track(instance.run('a', { signal: controller.signal }));
    controller.abort();
    await flush();
    expect(cancelled.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('is gone when a waiting job is cancelled', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    void track(instance.run('a'));
    const controller = new AbortController();
    const waiting = track(instance.run('b', { signal: controller.signal }));
    controller.abort();
    await flush();
    expect(waiting.state()).toBe('rejected');
    expect(listeners(controller.signal)).toBe(0);
    expect(instance.queued).toBe(0);
  });

  it('is gone when the pool is terminated', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const runningController = new AbortController();
    const waitingController = new AbortController();
    void track(instance.run('a', { signal: runningController.signal }));
    void track(instance.run('b', { signal: waitingController.signal }));
    instance.terminate();
    await flush();
    expect(listeners(runningController.signal)).toBe(0);
    expect(listeners(waitingController.signal)).toBe(0);
  });

  it('does not stop a later job when the signal of a finished one aborts', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const done = instance.run('a', { signal: controller.signal });
    result(worker(factory, 0), 'A');
    await done;
    const second = track(instance.run('b'));
    controller.abort();
    await flush();
    expect(worker(factory, 0).terminated).toBe(false);
    expect(instance.running).toBe(1);
    expect(second.state()).toBe('pending');
  });
});

describe('a worker that is gone', () => {
  const progress = { type: 'progress', id: 0, progress: { completed: 1, total: 2 } };

  it('reports no progress after its job was cancelled', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const controller = new AbortController();
    const onProgress = vi.fn();
    const cancelled = track(instance.run('a', { signal: controller.signal, onProgress }));
    controller.abort();
    await flush();
    worker(factory, 0).reply(progress);
    expect(onProgress).not.toHaveBeenCalled();
    expect(cancelled.state()).toBe('rejected');
  });

  it('reports no progress after it crashed', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const onProgress = vi.fn();
    const lost = track(instance.run('a', { onProgress }));
    worker(factory, 0).emit('error', { message: 'boom' });
    await flush();
    worker(factory, 0).reply(progress);
    expect(onProgress).not.toHaveBeenCalled();
    expect(lost.state()).toBe('rejected');
  });

  it('reports no progress after the pool was terminated', async () => {
    const factory = new Factory();
    const instance = pool(1, factory);
    const onProgress = vi.fn();
    const lost = track(instance.run('a', { onProgress }));
    instance.terminate();
    await flush();
    worker(factory, 0).reply(progress);
    expect(onProgress).not.toHaveBeenCalled();
    expect(lost.state()).toBe('rejected');
  });

  it('is stopped once however often the pool is terminated', async () => {
    const factory = new Factory();
    const instance = pool(2, factory);
    void track(instance.run('a'));
    void track(instance.run('b'));
    let stops = 0;
    for (const started of factory.workers) {
      const stop = started.terminate.bind(started);
      started.terminate = (): void => {
        stops += 1;
        stop();
      };
    }
    instance.terminate();
    instance.terminate();
    await flush();
    expect(stops).toBe(2);
  });
});
