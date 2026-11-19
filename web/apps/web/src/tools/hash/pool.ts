import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Input, Output } from './task.ts';

/** One worker: a file is hashed at a time, and a second one would only compete for the disk. */
export function createPool(): WorkerPool<Input, Output> {
  return createWorkerPool<Input, Output>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    size: 1,
  });
}
