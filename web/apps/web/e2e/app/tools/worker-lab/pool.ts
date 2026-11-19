import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Digest, Input } from './task.ts';

/** Two workers: small enough that a handful of files has to queue. */
export const POOL_SIZE = 2;

export function createPool(): WorkerPool<Input, Digest> {
  return createWorkerPool<Input, Digest>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    size: POOL_SIZE,
  });
}
