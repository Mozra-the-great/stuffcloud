import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Input, Output } from './task.ts';

/**
 * One worker: an operation that never ends (a pattern that backtracks without end) is stopped by
 * terminating it (the page does that on a timeout), and the pool starts a fresh one for the next job.
 */
export function createPool(): WorkerPool<Input, Output> {
  return createWorkerPool<Input, Output>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    size: 1,
  });
}
