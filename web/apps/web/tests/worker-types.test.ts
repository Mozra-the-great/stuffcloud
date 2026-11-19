import { createWorkerPool, type AbortSignalLike, type WorkerLike } from '@stuffcloud/tools';
import { describe, expect, it } from 'vitest';

/**
 * The package is built without the DOM lib, so only the app can prove that the browser's own
 * `Worker` fits the interface the pool asks for. These assignments are the proof: a change that
 * breaks them fails `pnpm typecheck`. (Nothing here starts a worker.)
 */
describe('the browser Worker type fits WorkerLike', () => {
  it('a Worker is a WorkerLike', () => {
    const asLike = (worker: Worker): WorkerLike => worker;
    expect(typeof asLike).toBe('function');
  });

  it('an AbortSignal is an AbortSignalLike', () => {
    const asLike = (signal: AbortSignal): AbortSignalLike => signal;
    expect(typeof asLike).toBe('function');
  });

  it('createWorkerPool accepts the usual `new Worker(...)` factory', () => {
    const make = (): unknown =>
      createWorkerPool<string, string>({
        create: () => new Worker('/never-started.js', { type: 'module' }),
      });
    expect(typeof make).toBe('function');
  });
});
