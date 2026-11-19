import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Input, Output } from './parse.ts';

/**
 * One worker: a text that takes `marked` too long is stopped by terminating it (the page does that on a
 * timeout), and the pool starts a fresh one for the next job. Call `terminate()` when the page goes away.
 */
export function createPool(): WorkerPool<Input, Output> {
  return createWorkerPool<Input, Output>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    size: 1,
  });
}
