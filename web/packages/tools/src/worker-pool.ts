import { isReply, type Progress, type Reply, type RunRequest } from './worker-protocol.ts';

/** An event of a worker, reduced to what the pool reads (a real `Worker` event fits). */
export interface WorkerEventLike {
  readonly type?: string;
  readonly data?: unknown;
  readonly message?: unknown;
}

/** What the pool needs from a worker; the browser's `Worker` satisfies it. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: object[]): void;
  terminate(): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: WorkerEventLike) => void,
  ): void;
}

/** The parts of an `AbortSignal` the pool uses (a real one fits; this package is built without the DOM lib). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface WorkerPoolOptions {
  /** Starts one worker, for example `() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. */
  readonly create: () => WorkerLike;
  /** Most workers running at once; defaults to {@link defaultPoolSize} for this machine. */
  readonly size?: number;
}

export interface RunOptions {
  /** Aborting rejects the job with the signal's reason (an `Error`) and stops its worker. */
  readonly signal?: AbortSignalLike | undefined;
  readonly onProgress?: ((progress: Progress) => void) | undefined;
  /** Buffers of the input that are moved to the worker instead of copied. */
  readonly transfer?: object[] | undefined;
}

/** The worker finished the job with an error (its handler threw). */
export class WorkerTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTaskError';
  }
}

/** The worker died or broke the protocol; the job is lost, the pool starts a fresh worker. */
export class WorkerCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerCrashError';
  }
}

/** The pool was terminated before the job could finish, or `run` was called afterwards. */
export class PoolTerminatedError extends Error {
  constructor() {
    super('the worker pool was terminated');
    this.name = 'PoolTerminatedError';
  }
}

export const MAX_DEFAULT_POOL_SIZE = 4;

/**
 * One core stays free for the page, at most {@link MAX_DEFAULT_POOL_SIZE} workers (each holds
 * its own copy of the data), at least one. Unknown core counts give two.
 */
export function defaultPoolSize(cores: number | undefined): number {
  // Stryker disable next-line ConditionalExpression: `Number.isFinite(undefined)` is false as well, so the second operand already returns 2 for an unknown count; the first only narrows the type for the compiler
  if (cores === undefined || !Number.isFinite(cores) || cores < 1) {
    return 2;
  }
  return Math.max(1, Math.min(MAX_DEFAULT_POOL_SIZE, Math.floor(cores) - 1));
}

interface Job<O> {
  readonly id: number;
  readonly input: unknown;
  readonly options: RunOptions;
  readonly resolve: (output: O) => void;
  readonly reject: (error: unknown) => void;
  detach: () => void;
}

interface Slot<O> {
  readonly worker: WorkerLike;
  job: Job<O> | undefined;
}

/**
 * A fixed-size pool of workers with a first-in-first-out queue, progress and cancellation.
 * Workers start when the first job needs them and stay until {@link terminate}, so the owner
 * of the pool (a tool page) creates it when the tool opens and terminates it when the page goes.
 */
export class WorkerPool<I = unknown, O = unknown> {
  readonly #create: () => WorkerLike;
  readonly #size: number;
  readonly #queue: Job<O>[] = [];
  readonly #slots: Slot<O>[] = [];
  #nextId = 0;
  #terminated = false;

  constructor(options: WorkerPoolOptions) {
    const size =
      options.size ??
      defaultPoolSize(
        (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
          ?.hardwareConcurrency,
      );
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(
        `the pool size must be a whole number of at least 1, got ${String(size)}`,
      );
    }
    this.#create = options.create;
    this.#size = size;
  }

  /** Maximum number of workers. */
  get size(): number {
    return this.#size;
  }

  /** Workers started so far and not yet gone. */
  get workers(): number {
    return this.#slots.length;
  }

  /** Jobs waiting for a free worker. */
  get queued(): number {
    return this.#queue.length;
  }

  /** Jobs a worker is working on right now. */
  get running(): number {
    return this.#slots.filter((slot) => slot.job !== undefined).length;
  }

  /**
   * Runs `input` on a free worker (or waits for one). Resolves with the worker's output;
   * rejects with {@link WorkerTaskError} when the handler throws, {@link WorkerCrashError}
   * when the worker dies, the signal's reason when aborted, {@link PoolTerminatedError}
   * when the pool is gone.
   */
  run(input: I, options: RunOptions = {}): Promise<O> {
    if (this.#terminated) {
      return Promise.reject(new PoolTerminatedError());
    }
    const { signal } = options;
    if (signal?.aborted === true) {
      return Promise.reject(abortError(signal.reason));
    }
    return new Promise<O>((resolve, reject) => {
      const job: Job<O> = {
        id: this.#nextId,
        input,
        options,
        resolve,
        reject,
        detach: (): void => undefined,
      };
      this.#nextId += 1;
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#cancel(job, abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort);
        job.detach = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }
      this.#queue.push(job);
      this.#pump();
    });
  }

  /** Stops every worker and rejects every job that has not finished. Safe to call twice. */
  terminate(): void {
    this.#terminated = true;
    const jobs = [...this.#queue, ...this.#slots.flatMap((slot) => (slot.job ? [slot.job] : []))];
    this.#queue.length = 0;
    for (const slot of this.#slots.splice(0)) {
      slot.worker.terminate();
    }
    for (const job of jobs) {
      this.#settle(job, () => {
        job.reject(new PoolTerminatedError());
      });
    }
  }

  #settle(job: Job<O>, action: () => void): void {
    job.detach();
    action();
  }

  #pump(): void {
    for (;;) {
      const job = this.#queue[0];
      if (job === undefined) {
        return;
      }
      let slot = this.#slots.find((candidate) => candidate.job === undefined);
      if (slot === undefined) {
        if (this.#slots.length >= this.#size) {
          return;
        }
        try {
          slot = this.#spawn();
        } catch (error: unknown) {
          // The worker could not be started (blocked script, bad URL): that job cannot run.
          this.#queue.shift();
          this.#settle(job, () => {
            job.reject(new WorkerCrashError(`could not start a worker: ${describe(error)}`));
          });
          continue;
        }
      }
      this.#queue.shift();
      this.#assign(slot, job);
    }
  }

  #spawn(): Slot<O> {
    const worker = this.#create();
    const slot: Slot<O> = { worker, job: undefined };
    worker.addEventListener('message', (event) => {
      this.#onMessage(slot, event.data);
    });
    worker.addEventListener('error', (event) => {
      this.#crash(slot, new WorkerCrashError(`the worker failed: ${describe(event.message)}`));
    });
    worker.addEventListener('messageerror', () => {
      this.#crash(slot, new WorkerCrashError('the worker sent a message that could not be read'));
    });
    this.#slots.push(slot);
    return slot;
  }

  #assign(slot: Slot<O>, job: Job<O>): void {
    slot.job = job;
    const request: RunRequest = { type: 'run', id: job.id, input: job.input };
    try {
      slot.worker.postMessage(request, job.options.transfer);
    } catch (error: unknown) {
      // The input could not be sent (not cloneable): the worker itself is fine.
      slot.job = undefined;
      this.#settle(job, () => {
        job.reject(error);
      });
    }
  }

  #onMessage(slot: Slot<O>, data: unknown): void {
    if (!this.#slots.includes(slot)) {
      // A message that was already on its way when the worker was stopped.
      return;
    }
    const job = slot.job;
    if (job === undefined || !isReply(data) || data.id !== job.id) {
      this.#crash(slot, new WorkerCrashError('the worker broke the message protocol'));
      return;
    }
    const reply: Reply<O> = data as Reply<O>;
    if (reply.type === 'progress') {
      job.options.onProgress?.(reply.progress);
      return;
    }
    slot.job = undefined;
    this.#settle(job, () => {
      if (reply.type === 'result') {
        job.resolve(reply.output);
      } else {
        job.reject(new WorkerTaskError(reply.message));
      }
    });
    this.#pump();
  }

  /** Drops the worker; its job (if any) fails with `error`. */
  #crash(slot: Slot<O>, error: Error): void {
    const index = this.#slots.indexOf(slot);
    if (index === -1) {
      return;
    }
    this.#slots.splice(index, 1);
    slot.worker.terminate();
    const job = slot.job;
    if (job !== undefined) {
      this.#settle(job, () => {
        job.reject(error);
      });
    }
    this.#pump();
  }

  #cancel(job: Job<O>, reason: Error): void {
    const queued = this.#queue.indexOf(job);
    if (queued !== -1) {
      this.#queue.splice(queued, 1);
      this.#settle(job, () => {
        job.reject(reason);
      });
      return;
    }
    const slot = this.#slots.find((candidate) => candidate.job === job);
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable. The abort listener is removed when the job settles, so a job that is cancelled is always queued or running; the guard only narrows the type
    if (slot === undefined) {
      return;
    }
    this.#slots.splice(this.#slots.indexOf(slot), 1);
    slot.worker.terminate();
    this.#settle(job, () => {
      job.reject(reason);
    });
    this.#pump();
  }
}

/**
 * The error an aborted job rejects with: the signal's reason when it is an `Error` (the default
 * reason of `abort()` is an `AbortError` `DOMException`), else an `AbortError` that carries it.
 */
function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('the job was aborted', { cause: reason });
  error.name = 'AbortError';
  return error;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === 'string' && value !== '' ? value : 'unknown error';
}

export function createWorkerPool<I = unknown, O = unknown>(
  options: WorkerPoolOptions,
): WorkerPool<I, O> {
  return new WorkerPool<I, O>(options);
}
