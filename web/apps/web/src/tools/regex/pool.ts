import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Input, Output } from './task.ts';

/** Starts the pool when the tool needs it; call `terminate()` when the page goes away. */
export function createPool(): WorkerPool<Input, Output> {
  return createWorkerPool<Input, Output>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  });
}
